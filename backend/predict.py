"""Per-stock outlook engine.

Two models, both honest about their measured quality:

1. GLOBAL cross-sectional model — trained in the background on ~100 NIFTY
   constituents x 5y of daily bars (tens of thousands of samples). Labels are
   "did this stock beat NIFTY 50 over the next 10 days". Quality is measured by
   walk-forward validation (train on the past, test on the future, roll
   forward 4 times) — the closest thing to how the model is actually used.
   Weights are persisted to /data/outlook_model.json and retrained daily.

2. Per-stock model — the stock's own 5y history, same features/labels, for
   stocks whose idiosyncrasies the global model misses.

A model only contributes to the verdict when its out-of-sample accuracy clears
the edge threshold; otherwise the transparent rule score stands alone and the
UI says so. Robustness details: features are z-scored then clipped to +/-3
(winsorizing keeps a single crazy volume day from dominating), and labels use
excess return over NIFTY to strip market-wide noise. Walk-forward also reports
pooled out-of-fold trading statistics: calibration buckets, strong-BUY
precision, and the long/short return spread — surfaced in the Trades tab.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
from pathlib import Path

from fetchers import ta, yahoo, news as news_fetcher

logger = logging.getLogger("axewatch.predict")

MODEL_HORIZON_DAYS = 10
EDGE_THRESHOLD = 0.54  # walk-forward accuracy needed to influence the verdict
FEATURE_VERSION = 2  # bump whenever _MODEL_KEYS changes; stale disk weights are discarded
_OUTLOOK_CACHE: dict[str, tuple[float, dict]] = {}
_OUTLOOK_TTL = 1800


# ---------------------------------------------------------------------------
# features
# ---------------------------------------------------------------------------

_MODEL_KEYS = [
    # returns (60d/120d capture medium-term cross-sectional momentum,
    # the most robust effect in the cross-section of stock returns)
    "ret1", "ret5", "ret10", "ret20", "ret60", "ret120",
    # relative to market
    "rel5", "rel20", "rel60",
    # market sensitivity (60d beta / correlation vs NIFTY)
    "beta_60", "corr_60",
    # trend
    "px_sma20", "px_sma50", "px_sma200", "sma_ratio", "sma_slope20",
    # momentum
    "rsi", "rsi_slope", "macd_hist", "macd_slope", "stoch_k", "stoch_d",
    "stoch_cross", "roc",
    # mean-reversion / position-in-range
    "cci20", "williams_r", "donchian_pos",
    # candle anatomy
    "gap_pct", "body_pct", "range_atr",
    # volatility
    "atr_pct", "atr_pctile", "bb_pos", "bb_width", "bb_squeeze",
    # volume / money flow
    "obv_slope", "vol_chg", "mfi", "vol_zscore", "vol_ratio_60",
    "cmf20", "dist_vwap20", "turnover_trend",
    # advance character
    "upday_ratio_20", "consec_days", "ret_skew_20",
    # trend strength
    "adx", "w_trend",
    # support / resistance position
    "dist_20d_high", "dist_60d_high", "dist_52w_high", "dist_52w_low",
]


def _nifty_maps(bars: list[dict]) -> dict:
    """date-str -> {c, ret1, ret5, ret20, ret60} for the NIFTY index bars."""
    from datetime import datetime, timezone

    m: dict[str, dict] = {}
    closes = [b["c"] for b in bars]
    for i, b in enumerate(bars):
        d = datetime.fromtimestamp(b["t"], tz=timezone.utc).strftime("%Y-%m-%d")
        m[d] = {
            "c": closes[i],
            "ret1": (closes[i] / closes[i - 1] - 1) * 100 if i >= 1 else None,
            "ret5": (closes[i] / closes[i - 5] - 1) * 100 if i >= 5 else None,
            "ret20": (closes[i] / closes[i - 20] - 1) * 100 if i >= 20 else None,
            "ret60": (closes[i] / closes[i - 60] - 1) * 100 if i >= 60 else None,
        }
    return m


_NIFTY_MAPS_CACHE: tuple[float, dict | None] = (0.0, None)
_NIFTY_MAPS_TTL = 6 * 3600


def _cached_nifty_maps() -> dict | None:
    """NIFTY 5y relative-return maps, cached — Yahoo is 429-sensitive and the
    index history is identical for every symbol in an outlook cycle."""
    global _NIFTY_MAPS_CACHE
    ts, cached = _NIFTY_MAPS_CACHE
    if cached is not None and time.time() - ts < _NIFTY_MAPS_TTL:
        return cached
    hist = yahoo.history("^NSEI", "5y")
    maps = _nifty_maps(hist["rows"]) if hist else None
    if maps:
        _NIFTY_MAPS_CACHE = (time.time(), maps)
    return maps


def _vec(f: dict) -> list[float] | None:
    out = []
    for k in _MODEL_KEYS:
        val = f.get(k)
        if val is None or not math.isfinite(val):
            return None
        out.append(float(val))
    return out


def _series_ctx(bars: list[dict], nifty: dict | None):
    """Precompute all indicator series once (O(N)) and return a features_at(i)
    closure. This is the SINGLE source of truth for feature definitions — both
    training samples and the live inference vector come from here, so the model
    is always served exactly what it was trained on."""
    N = len(bars)
    if N < 260:
        return None, None
    from datetime import datetime, timezone

    c = [b["c"] for b in bars]
    h = [b["h"] for b in bars]
    l = [b["l"] for b in bars]
    o = [b.get("o", b["c"]) for b in bars]
    v = [b["v"] for b in bars]
    t = [b["t"] for b in bars]

    pc = [0.0]
    pc2 = [0.0]
    pv = [0.0]
    pv2 = [0.0]
    # typical-price x volume and close x volume (VWAP / turnover trend)
    ptv = [0.0]
    prv = [0.0]
    for i in range(N):
        pc.append(pc[-1] + c[i])
        pc2.append(pc2[-1] + c[i] * c[i])
        pv.append(pv[-1] + v[i])
        pv2.append(pv2[-1] + v[i] * v[i])
        tp_i = (h[i] + l[i] + c[i]) / 3
        ptv.append(ptv[-1] + tp_i * v[i])
        prv.append(prv[-1] + c[i] * v[i])

    # daily simple returns (for skew / beta / correlation windows)
    rets = [0.0] * N
    for i in range(1, N):
        rets[i] = c[i] / c[i - 1] - 1 if c[i - 1] else 0.0

    # signed consecutive up/down-day streak, capped at +/-10 (exhaustion gauge)
    streak = [0] * N
    for i in range(1, N):
        if c[i] > c[i - 1]:
            streak[i] = min(streak[i - 1] + 1 if streak[i - 1] > 0 else 1, 10)
        elif c[i] < c[i - 1]:
            streak[i] = max(streak[i - 1] - 1 if streak[i - 1] < 0 else -1, -10)
        else:
            streak[i] = 0

    # NIFTY closes aligned to these bar dates (None where the date is missing)
    nc: list[float | None] = [None] * N
    if nifty:
        for i in range(N):
            d = datetime.fromtimestamp(t[i], tz=timezone.utc).strftime("%Y-%m-%d")
            hit = nifty.get(d)
            nc[i] = hit["c"] if hit and hit.get("c") else None
    nrets = [0.0] * N
    nvalid = [False] * N
    for i in range(1, N):
        if nc[i] and nc[i - 1]:
            nrets[i] = nc[i] / nc[i - 1] - 1  # type: ignore[operator]
            nvalid[i] = True

    def sma(i: int, n: int) -> float:
        return (pc[i + 1] - pc[i + 1 - n]) / n

    def stdev(i: int, n: int) -> float:
        m = sma(i, n)
        var = (pc2[i + 1] - pc2[i + 1 - n]) / n - m * m
        return math.sqrt(max(var, 0.0))

    def ema_run(vals: list[float], n: int) -> list[float | None]:
        out: list[float | None] = [None] * len(vals)
        if len(vals) < n:
            return out
        k = 2.0 / (n + 1)
        e = sum(vals[:n]) / n
        out[n - 1] = e
        for i in range(n, len(vals)):
            e = vals[i] * k + e * (1 - k)
            out[i] = e
        return out

    ema12 = ema_run(c, 12)
    ema26 = ema_run(c, 26)
    macd_line: list[float | None] = [None] * N
    for i in range(N):
        if ema12[i] is not None and ema26[i] is not None:
            macd_line[i] = ema12[i] - ema26[i]
    first_macd = next((i for i, x in enumerate(macd_line) if x is not None), None)
    sig_raw = [x for x in macd_line[first_macd:] if x is not None] if first_macd is not None else []
    sig_run = ema_run(sig_raw, 9)
    signal_at: list[float | None] = [None] * N
    if first_macd is not None:
        k = 0
        for i in range(N):
            if macd_line[i] is not None:
                signal_at[i] = sig_run[k]
                k += 1

    # Wilder RSI
    rsi_s: list[float | None] = [None] * N
    if N > 15:
        g = l_ = 0.0
        for i in range(1, 15):
            d = c[i] - c[i - 1]
            g += max(d, 0.0)
            l_ += max(-d, 0.0)
        ag, al = g / 14, l_ / 14
        for i in range(15, N):
            d = c[i] - c[i - 1]
            ag = (ag * 13 + max(d, 0.0)) / 14
            al = (al * 13 + max(-d, 0.0)) / 14
            rsi_s[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)

    # Wilder ATR
    atr_s: list[float | None] = [None] * N
    trs = [h[0] - l[0]] + [
        max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])) for i in range(1, N)
    ]
    if N > 15:
        a = sum(trs[1:15]) / 14
        for i in range(15, N):
            a = (a * 13 + trs[i]) / 14
            atr_s[i] = a

    # Stochastic %K (14)
    stoch_s: list[float | None] = [None] * N
    for i in range(13, N):
        wh = max(h[i - 13 : i + 1])
        wl = min(l[i - 13 : i + 1])
        rng = wh - wl
        stoch_s[i] = 100.0 if rng == 0 else (c[i] - wl) / rng * 100

    # OBV prefix
    obv = [0.0] * N
    for i in range(1, N):
        d = 1 if c[i] > c[i - 1] else (-1 if c[i] < c[i - 1] else 0)
        obv[i] = obv[i - 1] + d * v[i]

    # MFI 14 (rolling money-flow sums)
    mfi_s: list[float | None] = [None] * N
    tp = [(h[i] + l[i] + c[i]) / 3 for i in range(N)]
    if N > 15:
        pos = neg = 0.0
        flows = []
        for i in range(1, N):
            flow = tp[i] * v[i]
            flows.append((1 if tp[i] > tp[i - 1] else (-1 if tp[i] < tp[i - 1] else 0), flow))
        for i in range(1, 15):
            sgn, flow = flows[i - 1]
            if sgn > 0:
                pos += flow
            elif sgn < 0:
                neg += flow
            mfi_s[14] = 100.0 if neg == 0 else 100 - 100 / (1 + pos / neg)
        for i in range(15, N):
            sgn_old, flow_old = flows[i - 15]
            if sgn_old > 0:
                pos -= flow_old
            elif sgn_old < 0:
                neg -= flow_old
            sgn, flow = flows[i - 1]
            if sgn > 0:
                pos += flow
            elif sgn < 0:
                neg += flow
            mfi_s[i] = 100.0 if neg == 0 else 100 - 100 / (1 + pos / neg)

    # Wilder ADX
    adx_s: list[float | None] = [None] * N
    if N > 30:
        pdm = [0.0]
        mdm = [0.0]
        for i in range(1, N):
            up, dn = h[i] - h[i - 1], l[i - 1] - l[i]
            pdm.append(up if (up > dn and up > 0) else 0.0)
            mdm.append(dn if (dn > up and dn > 0) else 0.0)
        atr14 = sum(trs[1:15])
        p14, m14 = sum(pdm[1:15]), sum(mdm[1:15])
        dxs = []
        for i in range(15, N):
            atr14 = atr14 - atr14 / 14 + trs[i]
            p14 = p14 - p14 / 14 + pdm[i]
            m14 = m14 - m14 / 14 + mdm[i]
            pdi = 100 * p14 / atr14 if atr14 else 0.0
            mdi = 100 * m14 / atr14 if atr14 else 0.0
            den = pdi + mdi
            dxs.append(100 * abs(pdi - mdi) / den if den else 0.0)
        if len(dxs) >= 14:
            run = sum(dxs[:14]) / 14
            for k in range(14, len(dxs)):
                run = (run * 13 + dxs[k]) / 14
                adx_s[15 + k] = run

    # rolling window extremes for support/resistance distances (window includes the current bar)
    def roll_max(i: int, n: int) -> float:
        return max(c[i - min(n - 1, i) : i + 1])

    def roll_min(i: int, n: int) -> float:
        return min(c[i - min(n - 1, i) : i + 1])

    bb_width_s = [0.0] * N
    for idx in range(19, N):
        m = sma(idx, 20)
        s = stdev(idx, 20)
        bb_width_s[idx] = (4 * s) / m * 100 if m else 0.0

    def features_at(i: int) -> dict | None:
        """Feature dict for bar i from the SAME series the trainer uses.

        Every input here is computed from bars[0..i] only (no lookahead), so
        calling this at i = N-1 yields the live inference vector with exactly
        the indicator definitions the model was trained on — closing the
        train/serve skew where _features_at() used the simpler ta.* variants.
        """
        f: dict = {}
        f["ret1"] = (c[i] / c[i - 1] - 1) * 100 if c[i - 1] else None
        f["ret5"] = (c[i] / c[i - 5] - 1) * 100 if c[i - 5] else None
        f["ret10"] = (c[i] / c[i - 10] - 1) * 100 if c[i - 10] else None
        f["ret20"] = (c[i] / c[i - 20] - 1) * 100 if c[i - 20] else None
        f["ret60"] = (c[i] / c[i - 60] - 1) * 100 if c[i - 60] else None
        f["ret120"] = (c[i] / c[i - 120] - 1) * 100 if c[i - 120] else None
        f["px_sma20"] = (c[i] / sma(i, 20) - 1) * 100
        f["px_sma50"] = (c[i] / sma(i, 50) - 1) * 100
        f["px_sma200"] = (c[i] / sma(i, 200) - 1) * 100
        s20, s50 = sma(i, 20), sma(i, 50)
        f["sma_ratio"] = (s20 / s50 - 1) * 100 if s50 else None
        s20_prev = sma(i - 10, 20) if i >= 29 else None
        f["sma_slope20"] = (s20 / s20_prev - 1) * 100 if s20_prev else None
        f["rsi"] = rsi_s[i]
        f["rsi_slope"] = (rsi_s[i] - rsi_s[i - 5]) if rsi_s[i] is not None and rsi_s[i - 5] is not None else None
        f["macd_hist"] = (
            (macd_line[i] - signal_at[i]) / c[i] * 100
            if macd_line[i] is not None and signal_at[i] is not None and c[i]
            else None
        )
        if macd_line[i] is not None and macd_line[i - 5] is not None and c[i]:
            f["macd_slope"] = (macd_line[i] - macd_line[i - 5]) / c[i] * 100
        else:
            f["macd_slope"] = None
        f["stoch_k"] = stoch_s[i]
        if i >= 15 and all(x is not None for x in stoch_s[i - 2 : i + 1]):
            d_val = sum(stoch_s[i - 2 : i + 1]) / 3  # type: ignore[misc]
            f["stoch_d"] = d_val
            f["stoch_cross"] = stoch_s[i] - d_val  # type: ignore[operator]
        else:
            f["stoch_d"] = f["stoch_cross"] = None
        f["roc"] = (c[i] / c[i - 10] - 1) * 100 if c[i - 10] else None
        # CCI(20): distance from typical-price mean in mean-deviation units
        tp_i = (h[i] + l[i] + c[i]) / 3
        tp_win = [(h[j] + l[j] + c[j]) / 3 for j in range(i - 19, i + 1)]
        tp_m = sum(tp_win) / 20
        tp_md = sum(abs(x - tp_m) for x in tp_win) / 20
        f["cci20"] = round((tp_i - tp_m) / (0.015 * tp_md), 1) if tp_md > 0 else 0.0
        # Williams %R(14) and Donchian-20 channel position
        hh14 = max(h[i - 13 : i + 1])
        ll14 = min(l[i - 13 : i + 1])
        f["williams_r"] = round((hh14 - c[i]) / (hh14 - ll14) * -100, 1) if hh14 > ll14 else 0.0
        hh20 = max(h[i - 19 : i + 1])
        ll20 = min(l[i - 19 : i + 1])
        f["donchian_pos"] = round((c[i] - ll20) / (hh20 - ll20), 3) if hh20 > ll20 else 0.5
        # candle anatomy: overnight gap, body conviction, range vs ATR
        f["gap_pct"] = round((o[i] / c[i - 1] - 1) * 100, 2) if c[i - 1] else 0.0
        day_rng = h[i] - l[i]
        f["body_pct"] = round((c[i] - o[i]) / day_rng, 3) if day_rng > 0 else 0.0
        f["range_atr"] = round(day_rng / atr_s[i], 2) if atr_s[i] else None
        f["atr_pct"] = atr_s[i] / c[i] * 100 if atr_s[i] and c[i] else None
        if i >= 74 and atr_s[i] and c[i]:
            cur_ap = atr_s[i] / c[i] * 100  # type: ignore[operator]
            past = [atr_s[j] / c[j] * 100 for j in range(i - 60, i) if atr_s[j] and c[j]]
            f["atr_pctile"] = round(sum(1 for x in past if x <= cur_ap) / len(past), 3) if past else 0.5
        else:
            f["atr_pctile"] = None
        m20 = sma(i, 20)
        sd20 = stdev(i, 20)
        upper, lower = m20 + 2 * sd20, m20 - 2 * sd20
        f["bb_pos"] = (c[i] - lower) / (upper - lower) if upper > lower else None
        f["bb_width"] = (upper - lower) / m20 * 100 if m20 else None
        if i >= 19:
            w_min = min(bb_width_s[max(19, i - 59) : i + 1])
            f["bb_squeeze"] = round(bb_width_s[i] / w_min, 3) if w_min and w_min > 0 else 1.0
        else:
            f["bb_squeeze"] = 1.0

        f["obv_slope"] = (obv[i] - obv[max(0, i - 20)]) / 20 / max((pv[i + 1] - pv[i + 1 - 20]) / 20, 1.0)
        avg_v_prev = (pv[i] - pv[max(0, i - 20)]) / 20
        f["vol_chg"] = (v[i] / avg_v_prev - 1) * 100 if avg_v_prev else None
        if i >= 59:
            avg_v60 = (pv[i + 1] - pv[i + 1 - 60]) / 60
            f["vol_ratio_60"] = round(v[i] / avg_v60, 3) if avg_v60 > 0 else 1.0
        else:
            f["vol_ratio_60"] = 1.0
        # Chaikin Money Flow(20): where in the daily range did volume land
        mf_num = mf_den = 0.0
        for j in range(i - 19, i + 1):
            rng_j = h[j] - l[j]
            mfm = ((c[j] - l[j]) - (h[j] - c[j])) / rng_j if rng_j > 0 else 0.0
            mf_num += mfm * v[j]
            mf_den += v[j]
        f["cmf20"] = round(mf_num / mf_den, 3) if mf_den > 0 else 0.0
        # distance from 20d VWAP (institutional anchor) and turnover trend
        vwap20 = (ptv[i + 1] - ptv[i + 1 - 20]) / max((pv[i + 1] - pv[i + 1 - 20]), 1.0)
        f["dist_vwap20"] = round((c[i] / vwap20 - 1) * 100, 2) if vwap20 > 0 else 0.0
        if i >= 59:
            to20 = (prv[i + 1] - prv[i + 1 - 20]) / 20
            to60 = (prv[i + 1] - prv[i + 1 - 60]) / 60
            f["turnover_trend"] = round((to20 / to60 - 1) * 100, 2) if to60 > 0 else 0.0
        else:
            f["turnover_trend"] = 0.0
        # advance character: breadth, streak, skew of recent daily returns
        f["upday_ratio_20"] = round(sum(1 for j in range(i - 19, i + 1) if c[j] > c[j - 1]) / 20, 3)
        f["consec_days"] = float(streak[i])
        rw = rets[i - 19 : i + 1]
        rm = sum(rw) / 20
        rvar = sum((x - rm) ** 2 for x in rw) / 20
        rsd = math.sqrt(rvar)
        if rsd > 0:
            f["ret_skew_20"] = round(sum((x - rm) ** 3 for x in rw) / 20 / (rsd ** 3), 3)
        else:
            f["ret_skew_20"] = 0.0
        if i >= 19:
            vm = (pv[i + 1] - pv[i + 1 - 20]) / 20
            vvar = (pv2[i + 1] - pv2[i + 1 - 20]) / 20 - vm * vm
            vsd = math.sqrt(max(vvar, 0.0))
            f["vol_zscore"] = round((v[i] - vm) / vsd, 3) if vsd > 0 else 0.0
        else:
            f["vol_zscore"] = 0.0

        f["mfi"] = mfi_s[i]
        f["adx"] = adx_s[i]
        if i >= 99:
            sw_f = sma(i, 50)
            sw_s = sma(i, 100)
            f["w_trend"] = round((sw_f / sw_s - 1) * 100, 3) if sw_s else 0.0
        else:
            f["w_trend"] = 0.0

        f["dist_20d_high"] = (c[i] / roll_max(i, 20) - 1) * 100
        f["dist_60d_high"] = (c[i] / roll_max(i, 60) - 1) * 100
        f["dist_52w_high"] = (c[i] / roll_max(i, min(252, i)) - 1) * 100
        f["dist_52w_low"] = (c[i] / roll_min(i, min(252, i)) - 1) * 100
        # 60d beta / correlation vs NIFTY from aligned daily returns
        pairs = [(rets[j], nrets[j]) for j in range(i - 59, i + 1) if nvalid[j]]
        if len(pairs) >= 45:
            sx = [p[0] for p in pairs]
            sy = [p[1] for p in pairs]
            mx, my = sum(sx) / len(sx), sum(sy) / len(sy)
            cov = sum((a - mx) * (b - my) for a, b in pairs) / len(pairs)
            vx = sum((a - mx) ** 2 for a in sx) / len(sx)
            vy = sum((b - my) ** 2 for b in sy) / len(sy)
            f["beta_60"] = round(cov / vy, 3) if vy > 0 else 1.0
            f["corr_60"] = round(cov / math.sqrt(vx * vy), 3) if vx > 0 and vy > 0 else 0.0
        else:
            f["beta_60"] = f["corr_60"] = None
        if nifty:
            d = datetime.fromtimestamp(t[i], tz=timezone.utc).strftime("%Y-%m-%d")
            n = nifty.get(d)
            for k, rk, nk in (("ret5", "rel5", "ret5"), ("ret20", "rel20", "ret20"), ("ret60", "rel60", "ret60")):
                sv, nv = f.get(k), (n or {}).get(nk)
                f[rk] = sv - nv if sv is not None and nv is not None else None
        else:
            f["rel5"] = f["rel20"] = f["rel60"] = None
        return f

    return features_at, t


def _samples_from_bars(bars: list[dict], nifty: dict | None):
    """[(t, vec, label, fwd_excess)] — label: stock beat the market (or rose,
    if no nifty) over the next H days; fwd_excess is that forward excess
    return as a fraction, used for spread/calibration statistics.

    Feature computation is incremental: every indicator is precomputed as a
    series once (prefix sums / Wilder running averages), so sampling the whole
    history is O(N) per stock. The naive "slice + recompute at every bar" cost
    O(N^2) and stalled training on 100 stocks x 5y.
    """
    from datetime import datetime, timezone

    features_at, t = _series_ctx(bars, nifty)
    if features_at is None:
        return []
    N = len(bars)
    c = [b["c"] for b in bars]

    out = []
    horizon = MODEL_HORIZON_DAYS
    for i in range(210, N - horizon):
        f = features_at(i)

        vec = _vec(f)
        if vec is None:
            continue
        fwd = c[i + horizon] / c[i] - 1
        if nifty:
            d0 = datetime.fromtimestamp(t[i], tz=timezone.utc).strftime("%Y-%m-%d")
            d1 = datetime.fromtimestamp(t[i + horizon], tz=timezone.utc).strftime("%Y-%m-%d")
            n0, n1 = nifty.get(d0), nifty.get(d1)
            if n0 and n1 and n0["c"]:
                fwd -= n1["c"] / n0["c"] - 1
        out.append((t[i], vec, 1 if fwd > 0 else 0, fwd))
    return out


def _latest_features_series(bars: list[dict], nifty: dict | None) -> dict | None:
    """Live feature dict for the most recent bar, from the training engine."""
    features_at, _ = _series_ctx(bars, nifty)
    if features_at is None:
        return None
    return features_at(len(bars) - 1)


# ---------------------------------------------------------------------------
# logistic regression with robust scaling + walk-forward validation
# ---------------------------------------------------------------------------


class Scaler:
    def __init__(self, rows: list[list[float]]):
        n, d = len(rows), len(rows[0])
        self.means = [sum(r[j] for r in rows) / n for j in range(d)]
        self.stds = []
        for j in range(d):
            var = sum((r[j] - self.means[j]) ** 2 for r in rows) / n
            self.stds.append(math.sqrt(var) or 1.0)

    def z(self, x: list[float]) -> list[float]:
        return [max(-3.0, min(3.0, (x[j] - self.means[j]) / self.stds[j])) for j in range(len(x))]

    def to_dict(self):
        return {"means": self.means, "stds": self.stds}

    @classmethod
    def from_dict(cls, d):
        s = cls.__new__(cls)
        s.means, s.stds = d["means"], d["stds"]
        return s


class Logistic:
    def __init__(self, d: int):
        self.w = [0.0] * d
        self.b = 0.0

    def prob(self, x: list[float]) -> float:
        z = sum(wi * xi for wi, xi in zip(self.w, x)) + self.b
        z = max(-30.0, min(30.0, z))
        return 1 / (1 + math.exp(-z))

    def to_dict(self):
        return {"w": self.w, "b": self.b}

    @classmethod
    def from_dict(cls, d):
        m = cls(len(d["w"]))
        m.w, m.b = d["w"], d["b"]
        return m


def _fit_logistic(
    rows: list[list[float]],
    labels: list[int],
    epochs: int = 600,
    lr: float = 0.2,
    l2: float = 0.005,
    sample_times: list[float] | None = None,
    now: float | None = None,
) -> Logistic:
    d = len(rows[0])
    scaler = Scaler(rows)
    tx = [scaler.z(r) for r in rows]

    # class balancing: equalize positive/negative mass so the 0.5 threshold
    # stays meaningful even when up/down days are imbalanced
    n_pos = sum(1 for y in labels if y == 1) or 1
    n_neg = len(labels) - n_pos or 1
    w_pos = len(labels) / (2 * n_pos)
    w_neg = len(labels) / (2 * n_neg)

    # recency weighting: recent regimes matter more; ~180-day half-life.
    # weights are normalized to mean 1 so the effective learning rate is stable.
    if sample_times and len(sample_times) == len(labels):
        now = now or time.time()
        half_life = 180.0 * 86400
        raw = [math.exp(-((now - ts) / half_life) * math.log(2)) for ts in sample_times]
        mean_w = sum(raw) / len(raw) or 1.0
        recency = [w / mean_w for w in raw]
    else:
        recency = [1.0] * len(labels)

    m = Logistic(d)
    for epoch in range(epochs):
        rate = lr * (1.0 - epoch / (2 * epochs))  # linear decay
        gw, gb = [0.0] * d, 0.0
        for x, y, rw in zip(tx, labels, recency):
            err = (m.prob(x) - y) * (w_pos if y == 1 else w_neg) * rw
            for j in range(d):
                gw[j] += err * x[j]
            gb += err
        n = len(tx)
        for j in range(d):
            m.w[j] -= rate * (gw[j] / n + l2 * m.w[j])
        m.b -= rate * gb / n
    m.scaler = scaler
    return m


def _accuracy(m: Logistic, xs, ys):
    if not xs:
        return None, None
    preds = [(m.prob(m.scaler.z(x)) >= 0.5, y) for x, y in zip(xs, ys)]
    acc = sum(1 for p, y in preds if p == y) / len(preds)
    probs = [m.prob(m.scaler.z(x)) for x in xs]
    pos = [p for p, y in zip(probs, ys) if y == 1]
    neg = [p for p, y in zip(probs, ys) if y == 0]
    if pos and neg:
        wins = sum(1 for a in pos for bb in neg if a > bb) + 0.5 * sum(1 for a in pos for bb in neg if a == bb)
        auc = wins / (len(pos) * len(neg))
    else:
        auc = None
    return acc, auc


def _oof_stats(oof: list[tuple[float, int, float]]) -> dict:
    """Honest trading statistics from pooled out-of-fold predictions.

    oof: (prob_up, label, fwd_excess) across all walk-forward test blocks.
    Buckets show calibration (does 70% confidence win ~70% of the time?);
    long_precision answers "when the model says strong BUY, how often is it
    right?"; spread answers "how much more do its picks earn than its pans?".
    """
    n = len(oof)
    if n < 30:
        return {
            "buckets": [], "long_precision": None, "long_n": 0,
            "spread_bps": None, "base_rate": None, "n_test": n,
        }
    by_prob = sorted(oof, key=lambda r: r[0])
    buckets = []
    q = 5
    for b in range(q):
        grp = by_prob[b * n // q : (b + 1) * n // q] or by_prob[b * n // q :]
        if not grp:
            continue
        acc = sum(r[1] for r in grp) / len(grp)
        buckets.append({
            "lo": round(grp[0][0], 3),
            "hi": round(grp[-1][0], 3),
            "n": len(grp),
            "acc": round(acc, 3),
        })
    longs = [r for r in oof if r[0] >= 0.55]
    long_precision = round(sum(r[1] for r in longs) / len(longs), 3) if len(longs) >= 20 else None
    up_fwds = [r[2] for r in oof if r[0] >= 0.5]
    dn_fwds = [r[2] for r in oof if r[0] < 0.5]
    spread_bps = (
        round((sum(up_fwds) / len(up_fwds) - sum(dn_fwds) / len(dn_fwds)) * 10000, 1)
        if up_fwds and dn_fwds
        else None
    )
    return {
        "buckets": buckets,
        "long_precision": long_precision,
        "long_n": len(longs),
        "spread_bps": spread_bps,
        "base_rate": round(sum(r[1] for r in oof) / n, 3),
        "n_test": n,
    }


def _walk_forward(samples: list[tuple], folds: int = 4):
    """samples sorted by time t. Expanding-window: train on everything before
    each cut, test on the block after it. Returns per-fold + mean metrics plus
    pooled out-of-fold trading statistics.

    A MODEL_HORIZON_DAYS embargo is applied at every fold boundary: overlapping
    10-day label windows would otherwise let the tail of the training block
    peek into the test block, inflating accuracy. Purging those samples makes
    the estimate honest."""
    samples = sorted(samples, key=lambda s: s[0])
    n = len(samples)
    embargo = MODEL_HORIZON_DAYS + 1
    results = []
    oof: list[tuple[float, int, float]] = []
    for k in range(folds):
        cut_start = int(n * (0.5 + 0.1 * k))
        cut_end = int(n * (0.6 + 0.1 * k)) if k < folds - 1 else n
        if cut_start < 150 or cut_end - cut_start < 30:
            continue
        train = samples[: max(0, cut_start - embargo)]
        test = samples[cut_start:cut_end]
        if len(train) < 150:
            continue
        m = _fit_logistic(
            [s[1] for s in train],
            [s[2] for s in train],
            sample_times=[s[0] for s in train],
            now=samples[-1][0],
        )
        acc, auc = _accuracy(m, [s[1] for s in test], [s[2] for s in test])
        if acc is not None:
            results.append({"accuracy": acc, "auc": auc, "n_test": len(test)})
            for s in test:
                oof.append((m.prob(m.scaler.z(s[1])), s[2], s[3] if len(s) > 3 else 0.0))
    if not results:
        return None
    mean_acc = sum(r["accuracy"] for r in results) / len(results)
    aucs = [r["auc"] for r in results if r["auc"] is not None]
    mean_auc = sum(aucs) / len(aucs) if aucs else None
    out = {"folds": results, "mean_accuracy": mean_acc, "mean_auc": mean_auc}
    out.update(_oof_stats(oof))
    return out


# ---------------------------------------------------------------------------
# per-stock model (quick, cached per symbol)
# ---------------------------------------------------------------------------

_PERSTOCK_CACHE: dict[str, tuple[float, dict | None]] = {}
_PERSTOCK_TTL = 6 * 3600


def model_outlook(bars: list[dict], nifty: dict | None) -> dict | None:
    bars = bars[-760:]  # ~3y is enough for the per-stock model and keeps it fast
    samples = _samples_from_bars(bars, nifty)
    if len(samples) < 150:
        return None
    wf = _walk_forward(samples, folds=3)
    if wf is None:
        return None
    final = _fit_logistic(
        [s[1] for s in samples],
        [s[2] for s in samples],
        epochs=150,
        sample_times=[s[0] for s in samples],
    )
    latest_f = _latest_features_series(bars, nifty)
    if latest_f is None:
        return None
    vec = _vec(latest_f)
    if vec is None:
        return None
    test_acc = wf["mean_accuracy"]
    has_edge = test_acc >= EDGE_THRESHOLD
    prob_up = final.prob(final.scaler.z(vec))
    return {
        "prob_up": round(prob_up, 3),
        "walk_forward_accuracy": round(test_acc, 3),
        "walk_forward_auc": round(wf["mean_auc"], 3) if wf["mean_auc"] is not None else None,
        "n_samples": len(samples),
        "n_test": wf.get("n_test"),
        "buckets": wf.get("buckets") or [],
        "long_precision": wf.get("long_precision"),
        "long_n": wf.get("long_n"),
        "spread_bps": wf.get("spread_bps"),
        "base_rate": wf.get("base_rate"),
        "has_edge": has_edge,
        "horizon_days": MODEL_HORIZON_DAYS,
        "note": (
            f"Per-stock model: trained on this stock's own history ({len(samples)} samples), "
            f"walk-forward accuracy {(test_acc or 0) * 100:.0f}%. "
            + ("Contributing to the verdict." if has_edge else "Below the edge threshold — ignored.")
        ),
    }


# ---------------------------------------------------------------------------
# global cross-sectional model (trained in the background)
# ---------------------------------------------------------------------------

_GLOBAL_LOCK = threading.Lock()
_GLOBAL: dict = {"status": "untrained", "model": None, "meta": None, "training": False, "error": None}
_GLOBAL_PATH = Path(os.environ.get("AXEWATCH_DB", "/data/axewatch.db")).parent / "outlook_model.json"
_GLOBAL_TTL = 86400


def global_status() -> dict:
    with _GLOBAL_LOCK:
        meta = _GLOBAL.get("meta") or {}
        return {
            "status": _GLOBAL["status"],
            "training": _GLOBAL["training"],
            "n_stocks": meta.get("n_stocks"),
            "n_samples": meta.get("n_samples"),
            "walk_forward_accuracy": meta.get("walk_forward_accuracy"),
            "walk_forward_auc": meta.get("walk_forward_auc"),
            "feature_version": meta.get("feature_version"),
            "n_features": meta.get("n_features"),
            "n_test": meta.get("n_test"),
            "buckets": meta.get("buckets") or [],
            "long_precision": meta.get("long_precision"),
            "long_n": meta.get("long_n"),
            "spread_bps": meta.get("spread_bps"),
            "base_rate": meta.get("base_rate"),
            "has_edge": meta.get("has_edge", False),
            "trained_at": meta.get("trained_at"),
            "error": _GLOBAL.get("error"),
        }


def _global_model_prob(vec: list[float]) -> float | None:
    with _GLOBAL_LOCK:
        model = _GLOBAL.get("model")
        if not model:
            return None
    return model.prob(model.scaler.z(vec))


def kick_global_training(force: bool = False) -> bool:
    """Start background training if missing/stale. Returns True if started."""
    with _GLOBAL_LOCK:
        if _GLOBAL["training"]:
            return False
        meta = _GLOBAL.get("meta") or {}
        fresh = meta.get("trained_at", 0) > time.time() - _GLOBAL_TTL
        if fresh and not force:
            return False
        _GLOBAL["training"] = True
        _GLOBAL["error"] = None
    threading.Thread(target=_train_global_worker, daemon=True).start()
    return True


def _load_global_from_disk() -> None:
    try:
        if not _GLOBAL_PATH.exists():
            return
        blob = json.loads(_GLOBAL_PATH.read_text(encoding="utf-8"))
        meta = blob.get("meta") or {}
        if meta.get("trained_at", 0) < time.time() - _GLOBAL_TTL * 7:
            return  # too old; retrain
        if meta.get("feature_version") != FEATURE_VERSION:
            logger.info(
                "discarding saved global model (feature v%s != v%s); retraining",
                meta.get("feature_version"), FEATURE_VERSION,
            )
            return
        if len((blob.get("model") or {}).get("w") or []) != len(_MODEL_KEYS):
            logger.info("discarding saved global model (feature count changed); retraining")
            return
        model = Logistic.from_dict(blob["model"])
        model.scaler = Scaler.from_dict(blob["scaler"])
        with _GLOBAL_LOCK:
            _GLOBAL["model"] = model
            _GLOBAL["meta"] = meta
            _GLOBAL["status"] = "ready"
    except Exception as exc:
        logger.warning("global model load failed: %s", exc)


def _train_global_worker() -> None:
    try:
        _train_global()
        with _GLOBAL_LOCK:
            _GLOBAL["status"] = "ready"
    except Exception as exc:
        logger.warning("global model training failed: %s", exc)
        with _GLOBAL_LOCK:
            _GLOBAL["status"] = "failed"
            _GLOBAL["error"] = str(exc)[:200]
    finally:
        with _GLOBAL_LOCK:
            _GLOBAL["training"] = False


def _train_global() -> None:
    from fetchers import nse as nse_fetcher
    from fetchers import health

    if not health.is_available("yahoo"):
        raise RuntimeError("yahoo cooling down; retry later")

    symbols: list[str] = []
    for idx in ("NIFTY 50", "NIFTY NEXT 50"):
        try:
            rows = nse_fetcher.index_stocks(idx)
        except Exception:
            continue
        for r in (rows or {}).get("data") or []:
            s = str(r.get("symbol", "")).strip().upper()
            if s and s not in symbols:
                symbols.append(s)
    if len(symbols) < 20:
        raise RuntimeError(f"only {len(symbols)} constituent symbols available")

    nifty_hist = yahoo.history("^NSEI", "5y")
    nifty = _nifty_maps(nifty_hist["rows"]) if nifty_hist else None

    samples: list[tuple[float, list[float], int]] = []
    used = 0
    for k, sym in enumerate(symbols):
        if not health.is_available("yahoo"):
            logger.warning("global training aborted early: yahoo cooling down (%d/%d done)", used, len(symbols))
            break
        if k:
            time.sleep(0.4)
        hist = yahoo.history(sym, "5y")
        if not hist:
            continue
        got = _samples_from_bars(hist["rows"], nifty)
        if len(got) >= 100:
            samples.extend(got)
            used += 1
    if len(samples) < 2000 or used < 15:
        raise RuntimeError(f"insufficient training data ({used} stocks, {len(samples)} samples)")

    # cap pooled size: pure-python training cost scales linearly with samples x
    # epochs; 15k samples is plenty for 49 features and keeps a full retrain
    # (walk-forward + final fit) in the low minutes
    import random as _random

    if len(samples) > 15000:
        _random.seed(7)
        samples = _random.sample(samples, 15000)

    wf = _walk_forward(samples, folds=3)
    if wf is None:
        raise RuntimeError("walk-forward evaluation failed")
    final = _fit_logistic([s[1] for s in samples], [s[2] for s in samples], epochs=100)
    final.scaler = Scaler([s[1] for s in samples])
    meta = {
        "trained_at": time.time(),
        "n_stocks": used,
        "n_samples": len(samples),
        "feature_version": FEATURE_VERSION,
        "n_features": len(_MODEL_KEYS),
        "walk_forward_accuracy": round(wf["mean_accuracy"], 3),
        "walk_forward_auc": round(wf["mean_auc"], 3) if wf["mean_auc"] is not None else None,
        "n_test": wf.get("n_test"),
        "buckets": wf.get("buckets") or [],
        "long_precision": wf.get("long_precision"),
        "long_n": wf.get("long_n"),
        "spread_bps": wf.get("spread_bps"),
        "base_rate": wf.get("base_rate"),
        "has_edge": wf["mean_accuracy"] >= EDGE_THRESHOLD,
        "horizon_days": MODEL_HORIZON_DAYS,
        "label": "beats NIFTY 50 over next 10 days",
    }
    with _GLOBAL_LOCK:
        _GLOBAL["model"] = final
        _GLOBAL["meta"] = meta
    try:
        _GLOBAL_PATH.parent.mkdir(parents=True, exist_ok=True)
        _GLOBAL_PATH.write_text(
            json.dumps({"model": final.to_dict(), "scaler": final.scaler.to_dict(), "meta": meta}),
            encoding="utf-8",
        )
    except Exception as exc:
        logger.warning("global model save failed: %s", exc)
    logger.info(
        "global outlook model trained: %d stocks, %d samples, walk-forward acc %.3f",
        used, len(samples), wf["mean_accuracy"],
    )


# ---------------------------------------------------------------------------
# rule-based technical score (fully explainable) — unchanged in spirit
# ---------------------------------------------------------------------------


def _clamp(v: float) -> float:
    return max(-100.0, min(100.0, v))


def rule_score(f: dict, market: dict | None) -> tuple[float, list[dict]]:
    factors: list[dict] = []

    def add(cat: str, label: str, contribution: float, detail: str):
        factors.append(
            {"category": cat, "label": label, "contribution": round(contribution, 1), "detail": detail}
        )

    # --- trend (.25) ---
    t = 0.0
    for key, name in (("px_sma20", "SMA 20"), ("px_sma50", "SMA 50"), ("px_sma200", "SMA 200")):
        v = f.get(key)
        if v is None:
            continue
        if v > 1:
            t += 25
            add("trend", f"Above {name}", 25, f"price {v:+.1f}% vs {name}")
        elif v < -1:
            t -= 25
            add("trend", f"Below {name}", -25, f"price {v:+.1f}% vs {name}")
    s20, s50 = f.get("px_sma20"), f.get("px_sma50")
    if s20 is not None and s50 is not None:
        if s20 > 0 and s50 > 0:
            add("trend", "Moving averages aligned up", 20, "short-term average above long-term (uptrend structure)")
            t += 20
        elif s20 < 0 and s50 < 0:
            add("trend", "Moving averages aligned down", -20, "short-term average below long-term (downtrend structure)")
            t -= 20
    w_trend = f.get("w_trend")
    if w_trend is not None:
        if w_trend > 1.0:
            t += 15
            add("trend", "Weekly trend aligned up", 15, f"10w vs 20w proxy {w_trend:+.1f}% (multi-week tailwind)")
        elif w_trend < -1.0:
            t -= 15
            add("trend", "Weekly trend aligned down", -15, f"10w vs 20w proxy {w_trend:+.1f}% (multi-week headwind)")
    trend = _clamp(t)

    # --- momentum (.25) ---
    m = 0.0
    rsi_v = f.get("rsi")
    if rsi_v is not None:
        if rsi_v >= 75:
            m -= 20
            add("momentum", f"RSI {rsi_v:.0f} — overbought", -20, "stretched; pullbacks more likely")
        elif rsi_v >= 55:
            m += 25
            add("momentum", f"RSI {rsi_v:.0f} — strong", 25, "healthy bullish momentum zone")
        elif rsi_v <= 25:
            m += 10
            add("momentum", f"RSI {rsi_v:.0f} — oversold", 10, "bounces happen, but catching knives is risky")
        elif rsi_v < 45:
            m -= 20
            add("momentum", f"RSI {rsi_v:.0f} — weak", -20, "sellers in control")
    hist = f.get("macd_hist")
    if hist is not None:
        if hist > 0:
            m += 20
            add("momentum", "MACD above signal", 20, f"histogram {hist:+.2f}% — momentum turning/holding up")
        else:
            m -= 20
            add("momentum", "MACD below signal", -20, f"histogram {hist:+.2f}% — momentum fading")
    rel5 = f.get("rel5")
    if rel5 is not None:
        if rel5 > 1:
            m += 20
            add("momentum", "Outperforming NIFTY (1 week)", 20, f"{rel5:+.1f}% vs the index")
        elif rel5 < -1:
            m -= 20
            add("momentum", "Underperforming NIFTY (1 week)", -20, f"{rel5:+.1f}% vs the index")
    momentum = _clamp(m)

    # --- volume (.12) ---
    vol = 0.0
    obv_s = f.get("obv_slope")
    if obv_s is not None:
        if obv_s > 0.15:
            vol += 50
            add("volume", "OBV rising", 50, "accumulation — volume flows into up-days")
        elif obv_s < -0.15:
            vol -= 50
            add("volume", "OBV falling", -50, "distribution — volume flows into down-days")
    v_z = f.get("vol_zscore")
    if v_z is not None:
        if v_z > 2.0:
            vol += 25
            add("volume", f"Volume anomaly (Z = {v_z:.1f})", 25, "statistically significant volume surge")
        elif v_z < -1.5:
            vol -= 10
            add("volume", f"Quiet volume (Z = {v_z:.1f})", -10, "below-average participation")
    mfi_v = f.get("mfi")
    if mfi_v is not None:
        if mfi_v > 80:
            vol -= 20
            add("volume", f"MFI {mfi_v:.0f} — overheated", -20, "money flow stretched")
        elif mfi_v < 25:
            vol += 10
            add("volume", f"MFI {mfi_v:.0f} — washed out", 10, "money flow at pessimistic extremes")
    volume = _clamp(vol)

    # --- volatility / stretch (.08) ---
    vlt = 0.0
    atr_v = f.get("atr_pct")
    if atr_v is not None and atr_v > 4:
        vlt -= 40
        add("volatility", f"ATR {atr_v:.1f}% of price", -40, "large daily swings — higher risk either way")
    bb_sq = f.get("bb_squeeze")
    bb_w = f.get("bb_width")
    if bb_sq is not None and bb_w is not None and bb_sq <= 1.2 and bb_w < 5.0:
        vlt += 20
        add("volatility", "Bollinger Band squeeze", 20, "volatility contracted; breakout energy coiling")
    bb = f.get("bb_pos")
    if bb is not None:
        if bb > 1:
            vlt -= 30
            add("volatility", "Above upper Bollinger band", -30, "statistically stretched to the upside")
        elif bb < 0:
            vlt += 15
            add("volatility", "Below lower Bollinger band", 15, "stretched down — mean-reversion possibility")
    volatility = _clamp(vlt)

    # --- support/resistance (.12) ---
    sr = 0.0
    for key, name in (("dist_20d_high", "20-day high"), ("dist_52w_high", "52-week high")):
        v = f.get(key)
        if v is None:
            continue
        if abs(v) <= 2:
            sr += 15
            add("s/r", f"At {name}", 15, f"only {v:+.1f}% away — trading at the top of its range")
    low52 = f.get("dist_52w_low")
    if low52 is not None and low52 <= 3:
        sr -= 25
        add("s/r", "Near 52-week low", -25, f"{low52:+.1f}% from the yearly low — persistent weakness")
    adx_v = f.get("adx")
    if adx_v is not None and adx_v > 30:
        add("s/r", f"ADX {adx_v:.0f} — strong trend", 0, "trend is well established; scores above carry more weight")
    s_r = _clamp(sr)

    # --- market (.08) ---
    mk = 0.0
    if market:
        n1 = market.get("nifty_1d")
        n20 = market.get("nifty_20d")
        vix = market.get("vix")
        if n1 is not None:
            mk += 20 if n1 >= 0 else -20
            add("market", f"NIFTY 50 {n1:+.1f}% today", 20 if n1 >= 0 else -20, "broad market tailwind/headwind")
        if n20 is not None:
            mk += 20 if n20 >= 0 else -20
            add("market", f"NIFTY 50 {n20:+.1f}% over a month", 20 if n20 >= 0 else -20, "medium-term market direction")
        if vix is not None:
            if vix > 20:
                mk -= 20
                add("market", f"India VIX {vix:.1f} — elevated", -20, "fear index high; risk assets under pressure")
            elif vix < 13:
                mk += 10
                add("market", f"India VIX {vix:.1f} — calm", 10, "low-volatility regime favours drifting up")
    market_s = _clamp(mk)

    score = _clamp(
        trend * 0.25 + momentum * 0.25 + volume * 0.12 + volatility * 0.08
        + s_r * 0.12 + market_s * 0.08
    )
    categories = [
        {"name": "Trend", "score": round(trend, 1)},
        {"name": "Momentum", "score": round(momentum, 1)},
        {"name": "Volume", "score": round(volume, 1)},
        {"name": "Volatility", "score": round(volatility, 1)},
        {"name": "Support/Resistance", "score": round(s_r, 1)},
        {"name": "Market context", "score": round(market_s, 1)},
    ]
    return score, {"factors": factors, "categories": categories}


# ---------------------------------------------------------------------------
# news sentiment + red flags
# ---------------------------------------------------------------------------

_NEG_PATTERNS = [
    (r"resign|steps? down|fired|sacked|quit[s ]|ceo.{0,20}(out|exit)", "leadership exit"),
    (r"probe|investigat|fraud|scam|cheat|forgery|misappropriat", "probe / fraud"),
    (r"\bloss(es)?\b|weak (results|quarter|earnings|demand|sales)|miss(es|ed)? (estimates|expectations|street)|profit (fell|drop|decline)", "weak results"),
    (r"decline|slump|plunge|crash|tumble|tank[s ]?|sink", "sharp fall"),
    (r"default|bankrupt|insolv|debt (crisis|burden|worry)", "financial stress"),
    (r"downgrade|price target (cut|lowered)|sell rating", "analyst downgrade"),
    (r"layoff|laying off|job cuts?|retrench", "layoffs"),
    (r"sebi|regulator|penalty|fine[sd ]|court|legal", "regulatory / legal"),
    (r"promoter (pledge|selling)|stake sale by|governance concern", "governance / promoter"),
]
_POS_PATTERNS = [
    (r"surge|soar|jump|rally|rocket", "sharp rise"),
    (r"record (high|profit|revenue|sales|earnings)|all-time high", "record results"),
    (r"beats? (estimates|street|expectations)|profit (rises|rose|up|jumps|surge)|strong (results|quarter|earnings|demand)", "strong results"),
    (r"upgrade|price target (raise|hiked)|buy rating", "analyst upgrade"),
    (r"order win|bags? .{0,30}order|contract win|secures? .{0,30}order", "order wins"),
    (r"expansion|acquisition|acquires|new plant|capacity", "expansion"),
    (r"dividend|bonus|buyback", "shareholder payout"),
]


def news_signals(symbol: str) -> dict | None:
    try:
        payload = news_fetcher.stock_news(symbol, limit=12)
    except Exception as exc:
        logger.warning("news signals %s failed: %s", symbol, exc)
        return None
    pos, neg = 0, 0
    red_flags, positives = [], []
    now = time.time()
    for it in payload.get("items", []):
        text = (it.get("title") or "").lower()
        age_days = _age_days(it.get("published"), now)
        weight = 1.0 if age_days is None or age_days <= 30 else 0.5
        matched_neg = next((tag for pat, tag in _NEG_PATTERNS if re.search(pat, text)), None)
        matched_pos = next((tag for pat, tag in _POS_PATTERNS if re.search(pat, text)), None)
        if matched_neg and matched_pos:
            continue  # mixed headline ("rises despite slump") — no clear signal
        if matched_neg:
            neg += weight
            red_flags.append({**it, "why": matched_neg})
        elif matched_pos:
            pos += weight
            if len(positives) < 5:
                positives.append({**it, "why": matched_pos})
    score = _clamp(math.tanh((pos - neg * 1.25) / 3) * 100) if (pos or neg) else 0.0
    return {
        "score": round(score, 1),
        "positive_count": pos,
        "negative_count": neg,
        "red_flags": red_flags[:6],
        "positives": positives,
    }


def _age_days(pub: str | None, now: float) -> float | None:
    if not pub:
        return None
    from email.utils import parsedate_to_datetime

    try:
        dt = parsedate_to_datetime(pub)
        return (now - dt.timestamp()) / 86400
    except Exception:
        return None


# ---------------------------------------------------------------------------
# trade plan: signal + stop-loss + targets + timeframes
# ---------------------------------------------------------------------------


def _first_passage_days(bars: list[dict], up_pct: float, down_pct: float, max_days: int = 40) -> tuple[float | None, float | None]:
    """Median days for THIS stock to move +up_pct% or -down_pct%, measured from
    every recent day (first touch of either level). Real history, not theory."""
    up_hits, down_hits = [], []
    starts = list(range(max(0, len(bars) - 500), len(bars) - max_days, 3))
    for i in starts:
        entry = bars[i]["c"]
        for j in range(i + 1, min(i + 1 + max_days, len(bars))):
            if bars[j]["h"] >= entry * (1 + up_pct / 100):
                up_hits.append(j - i)
                break
            if bars[j]["l"] <= entry * (1 - down_pct / 100):
                down_hits.append(j - i)
                break
    med = lambda xs: (sorted(xs)[len(xs) // 2] if xs else None)
    return med(up_hits), med(down_hits)


def _trade_plan(bars: list[dict], f: dict, score: float) -> dict:
    entry = bars[-1]["c"]
    atr_v = f.get("atr_pct")
    atr = (atr_v / 100) * entry if atr_v else None
    signal = "BUY" if score >= 20 else ("SELL" if score <= -20 else "HOLD")

    if signal == "HOLD":
        # Neutral band: no directional edge worth risking capital. Presenting
        # precise stops/targets here would fake conviction the score doesn't
        # have — so we explicitly decline the trade instead.
        return {
            "signal": "HOLD",
            "no_trade": True,
            "direction": None,
            "strength": abs(score),
            "entry": round(entry, 2),
            "stop": None,
            "stop_pct": None,
            "target_1": None,
            "target_1_pct": None,
            "target_2": None,
            "target_2_pct": None,
            "reward_risk": None,
            "target_days": None,
            "stop_days": None,
            "risk_per_share": None,
            "suggested_qty_per_1k_risk": None,
            "suggested_qty_1pct_paper": None,
            "nearest_sr": None,
            "reason": (
                f"Score {score:+.0f} sits in the neutral band (−20 to +20): no "
                "directional edge worth risking capital. Stops and targets are "
                "shown only when the score actually calls BUY or SELL — a level "
                "without a signal is just noise."
            ),
            "method": "No plan is issued in the neutral band by design.",
            "note": (
                "Doing nothing is a valid position. Re-check after a directional "
                "move, or set your own levels — these are educational, not advice."
            ),
        }

    direction = "long" if signal != "SELL" else "short/exit"

    nearest_sr = None
    if atr:
        lows10 = min(b["l"] for b in bars[-10:])
        highs10 = max(b["h"] for b in bars[-10:])
        if signal == "SELL":
            stop = min(entry + 2 * atr, highs10 + 0.5 * atr)  # idea fails above this
            min_risk = max(1.2 * atr, 0.015 * entry)  # never tighter than noise
            if stop - entry < min_risk:
                stop = entry + min_risk
            risk = max(stop - entry, 0.5 * atr)
            t1, t2 = entry - 1.5 * risk, entry - 2.5 * risk
            sup20 = min(b["l"] for b in bars[-20:])
            if t1 < sup20 < entry and (entry - sup20) >= 0.8 * risk:
                nearest_sr = round(sup20, 2)
        else:
            vol_stop = entry - 2 * atr
            struct_stop = lows10 - 0.5 * atr  # below the recent floor
            stop = max(vol_stop, struct_stop)  # tighter of the two
            min_risk = max(1.2 * atr, 0.015 * entry)  # never tighter than noise
            if entry - stop < min_risk:
                stop = entry - min_risk
            risk = max(entry - stop, 0.5 * atr)
            t1, t2 = entry + 1.5 * risk, entry + 2.5 * risk
            res20 = max(b["h"] for b in bars[-20:])
            if t1 > res20 > entry and (res20 - entry) >= 0.8 * risk:
                nearest_sr = round(res20, 2)

        risk_per_share = round(risk, 2)
        suggested_qty_per_1k = max(1, math.floor(1000.0 / risk)) if risk > 0 else 1
        suggested_qty_1pct = max(1, math.floor(10000.0 / risk)) if risk > 0 else 1

        t1_pct, t2_pct = abs(t1 / entry - 1) * 100, abs(t2 / entry - 1) * 100
        stop_pct = abs(stop / entry - 1) * 100
        up_days, down_days = _first_passage_days(bars, t1_pct, stop_pct)
        target_days, stop_days = (down_days, up_days) if signal == "SELL" else (up_days, down_days)
    else:
        stop = t1 = t2 = None
        stop_pct = t1_pct = t2_pct = None
        target_days = stop_days = None
        risk_per_share = suggested_qty_per_1k = suggested_qty_1pct = None

    return {
        "signal": signal,
        "no_trade": False,
        "direction": direction,
        "strength": abs(score),
        "entry": round(entry, 2),
        "stop": round(stop, 2) if stop else None,
        "stop_pct": round(stop_pct, 2) if stop_pct else None,
        "target_1": round(t1, 2) if t1 else None,
        "target_1_pct": round(t1_pct, 2) if t1_pct else None,
        "target_2": round(t2, 2) if t2 else None,
        "target_2_pct": round(t2_pct, 2) if t2_pct else None,
        "reward_risk": 1.5,
        "target_days": target_days,
        "stop_days": stop_days,
        "risk_per_share": risk_per_share,
        "suggested_qty_per_1k_risk": suggested_qty_per_1k,
        "suggested_qty_1pct_paper": suggested_qty_1pct,
        "nearest_sr": nearest_sr,
        "method": (
            "Stop = 2x ATR(14) tightened to sit just under the 10-day floor "
            "( Sell: mirrored above the 10-day ceiling ). Targets = 1.5R and 2.5R. "
            "Timeframes are medians of how many days this stock historically needed "
            "to travel that distance. Signal itself comes from the transparent "
            "technical score, not the model."
        ),
        "note": (
            "Educational levels, not advice. A stop-loss only limits loss if you "
            "actually place it with your broker; gaps can slip past it."
        ),
    }


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------


def _market_context() -> dict:
    out: dict = {}
    nifty = yahoo.history("^NSEI", "1y")
    if nifty:
        rows = nifty["rows"]
        c = [r["c"] for r in rows]
        if len(c) > 21:
            out["nifty_1d"] = round((c[-1] / c[-2] - 1) * 100, 2)
            out["nifty_20d"] = round((c[-1] / c[-21] - 1) * 100, 2)
            rets = [(c[i] / c[i - 1] - 1) for i in range(len(c) - 20, len(c))]
            mean = sum(rets) / len(rets)
            sd = math.sqrt(sum((r - mean) ** 2 for r in rets) / len(rets))
            out["nifty_vol_annualized_pct"] = round(sd * math.sqrt(252) * 100, 1)
    try:
        import db

        snap = db.latest_snapshot("all_indices")
        if snap:
            for row in (snap["data"].get("data") or []):
                if (row.get("index") or "").upper() == "INDIA VIX":
                    out["vix"] = row.get("last")
                    break
    except Exception:
        pass
    return out


def outlook(symbol: str) -> dict | None:
    sym = symbol.strip().upper()
    ts, cached = _OUTLOOK_CACHE.get(sym, (0.0, None))
    if cached and time.time() - ts < _OUTLOOK_TTL:
        return cached
    kick_global_training()  # no-op when fresh/training

    hist = yahoo.history(sym, "5y")
    if not hist:
        return None
    bars = hist["rows"]
    nifty = _cached_nifty_maps()

    latest = _latest_features_series(bars, nifty)
    if latest is None:
        return None
    f = dict(latest)

    market = _market_context()
    rule, rule_detail = rule_score(f, market)
    per_stock = model_outlook(bars, nifty)
    gs = global_status()

    model_prob = None
    vec = _vec(f)
    g_prob = _global_model_prob(vec) if vec else None

    # blend models weighted by their out-of-sample edge (accuracy above 0.5)
    weights, probs = [], []
    if g_prob is not None and gs.get("has_edge") and gs.get("walk_forward_accuracy"):
        weights.append(max(0.0, gs["walk_forward_accuracy"] - 0.5))
        probs.append(g_prob)
        model_prob = g_prob
    if per_stock and per_stock["has_edge"] and per_stock["prob_up"] is not None:
        weights.append(max(0.0, per_stock["walk_forward_accuracy"] - 0.5))
        probs.append(per_stock["prob_up"])
    if weights:
        model_prob = sum(w * p for w, p in zip(weights, probs)) / sum(weights)

    news = news_signals(sym)
    sentiment_score = news["score"] if news else 0.0
    score = rule * 0.85 + sentiment_score * 0.15
    if model_prob is not None:
        model_component = (model_prob - 0.5) * 200
        score = score * 0.5 + model_component * 0.5

    score = _clamp(score)
    if score >= 20:
        label, color = "Bullish", "bullish"
    elif score <= -20:
        label, color = "Bearish", "bearish"
    else:
        label, color = "Neutral", "neutral"

    trade_plan = _trade_plan(bars, f, score)

    try:
        import db

        if trade_plan["signal"] in ("BUY", "SELL") and not trade_plan.get("no_trade"):
            db.log_signal(
                sym,
                trade_plan["signal"],
                score,
                trade_plan["entry"],
                trade_plan.get("stop"),
                trade_plan.get("target_1"),
                trade_plan.get("target_2"),
                MODEL_HORIZON_DAYS,
            )
    except Exception as exc:
        logger.warning("signal log %s failed: %s", sym, exc)

    if model_prob is not None:
        parts = []
        if g_prob is not None and gs.get("has_edge"):
            parts.append(
                f"global cross-stock model ({gs.get('n_stocks')} stocks, "
                f"{(gs.get('walk_forward_accuracy') or 0) * 100:.0f}% walk-forward accuracy)"
            )
        if per_stock and per_stock["has_edge"]:
            parts.append(f"this stock's own model ({per_stock['walk_forward_accuracy'] * 100:.0f}%)")
        note = "Verdict blends the technical score with: " + " + ".join(parts) + "."
    elif gs.get("status") == "ready":
        acc = gs.get("walk_forward_accuracy")
        note = (
            "No model cleared the accuracy threshold, so the verdict is the transparent "
            f"technical score only. Global model is trained ({gs.get('n_stocks')} stocks) but its "
            f"walk-forward accuracy is {(acc or 0) * 100:.0f}% — below the bar to trust."
        )
    elif gs.get("status") == "failed":
        note = f"Global model training failed ({gs.get('error')}); using technical score only."
    else:
        note = (
            "The global model is still training in the background (it reads ~100 stocks' 5-year "
            "history); the verdict below is the transparent technical score. Refresh in a few minutes."
        )

    payload = {
        "symbol": sym,
        "generated_at": time.time(),
        "horizon_days": MODEL_HORIZON_DAYS,
        "verdict": {"label": label, "color": color, "score": round(score, 1), "confidence": round(min(100, abs(score) * 1.6), 0)},
        "trade_plan": trade_plan,
        "model": per_stock,
        "global_model": gs,
        "model_note": note,
        "rule": {"score": round(rule, 1), **rule_detail},
        "sentiment": news,
        "market": market,
        "features": {k: (round(v, 2) if isinstance(v, (int, float)) else v) for k, v in f.items()},
        "disclaimer": (
            "Educational technical analysis, not investment advice. The score summarizes "
            "trend, momentum, volume and news; markets can and do surprise. Never buy or sell "
            "on this signal alone."
        ),
    }
    _OUTLOOK_CACHE[sym] = (time.time(), payload)
    return payload
