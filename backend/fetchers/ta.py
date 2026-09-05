"""Pure-python technical indicator library.

Input convention: every function takes chronological series (oldest first) of
floats (or OHLCV dicts for the combined ones) and returns the value as of the
LAST bar, plus series-returning helpers where the caller needs history
(e.g. EMA seeds, MACD signal, ADX smoothing).

No numpy in the backend image on purpose — these run on ~500 daily bars, well
inside pure-python performance territory.
"""

from __future__ import annotations

import math


def sma(vals: list[float], n: int) -> float | None:
    if len(vals) < n or n <= 0:
        return None
    return sum(vals[-n:]) / n


def ema_series(vals: list[float], n: int) -> list[float]:
    """Full EMA series, seeded with the SMA of the first n values."""
    if len(vals) < n:
        return []
    k = 2.0 / (n + 1)
    out = [sum(vals[:n]) / n]
    for v in vals[n:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def ema(vals: list[float], n: int) -> float | None:
    s = ema_series(vals, n)
    return s[-1] if s else None


def rsi(closes: list[float], n: int = 14) -> float | None:
    """Wilder-smoothed RSI as of the last bar."""
    if len(closes) < n + 1:
        return None
    gains, losses = [], []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    avg_g = sum(gains[:n]) / n
    avg_l = sum(losses[:n]) / n
    for i in range(n, len(gains)):
        avg_g = (avg_g * (n - 1) + gains[i]) / n
        avg_l = (avg_l * (n - 1) + losses[i]) / n
    if avg_l == 0:
        return 100.0
    rs = avg_g / avg_l
    return 100 - 100 / (1 + rs)


def macd(closes: list[float], fast: int = 12, slow: int = 26, signal_n: int = 9):
    """Returns (macd, signal, histogram) as of the last bar, or Nones."""
    if len(closes) < slow + signal_n:
        return None, None, None
    ef, es = ema_series(closes, fast), ema_series(closes, slow)
    # align: ema_series entries start at index fast-1 / slow-1 of closes
    macd_line = [f - s for f, s in zip(ef[len(ef) - len(es):], es)]
    sig = ema_series(macd_line, signal_n)
    if not sig:
        return macd_line[-1], None, None
    m, s = macd_line[-1], sig[-1]
    return m, s, m - s


def stochastic(highs: list[float], lows: list[float], closes: list[float], n: int = 14, d_n: int = 3):
    """Returns (%K, %D) as of the last bar."""
    if len(closes) < n + d_n:
        return None, None
    ks = []
    for i in range(len(closes) - d_n, len(closes)):
        window_h = max(highs[i - n + 1 : i + 1])
        window_l = min(lows[i - n + 1 : i + 1])
        rng = window_h - window_l
        ks.append(100.0 if rng == 0 else (closes[i] - window_l) / rng * 100)
    return ks[-1], sum(ks) / len(ks)


def roc(closes: list[float], n: int = 10) -> float | None:
    if len(closes) <= n or closes[-n - 1] == 0:
        return None
    return (closes[-1] / closes[-n - 1] - 1) * 100


def atr(highs: list[float], lows: list[float], closes: list[float], n: int = 14) -> float | None:
    """Wilder-smoothed ATR."""
    if len(closes) < n + 1:
        return None
    trs = []
    for i in range(1, len(closes)):
        trs.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])))
    a = sum(trs[:n]) / n
    for tr in trs[n:]:
        a = (a * (n - 1) + tr) / n
    return a


def bollinger(closes: list[float], n: int = 20, k: float = 2.0):
    """Returns (upper, middle, lower, width_pct)."""
    m = sma(closes, n)
    if m is None:
        return None, None, None, None
    window = closes[-n:]
    var = sum((c - m) ** 2 for c in window) / n
    sd = math.sqrt(var)
    upper, lower = m + k * sd, m - k * sd
    width = (upper - lower) / m * 100 if m else None
    return upper, m, lower, width


def rolling_std(vals: list[float], n: int = 20) -> float | None:
    if len(vals) < n:
        return None
    window = vals[-n:]
    m = sum(window) / n
    return math.sqrt(sum((v - m) ** 2 for v in window) / n)


def obv(closes: list[float], volumes: list[float]) -> float:
    total = 0.0
    for i in range(1, len(closes)):
        if closes[i] > closes[i - 1]:
            total += volumes[i]
        elif closes[i] < closes[i - 1]:
            total -= volumes[i]
    return total


def obv_slope(closes: list[float], volumes: list[float], n: int = 20) -> float | None:
    """Normalized OBV slope over the last n bars (OBV units per bar / avg volume)."""
    if len(closes) < n + 1:
        return None
    vals = [0.0]
    for i in range(1, len(closes)):
        if closes[i] > closes[i - 1]:
            vals.append(vals[-1] + volumes[i])
        elif closes[i] < closes[i - 1]:
            vals.append(vals[-1] - volumes[i])
        else:
            vals.append(vals[-1])
    avg_vol = max(sum(volumes[-n:]) / n, 1.0)
    return (vals[-1] - vals[-n]) / n / avg_vol


def vwap(highs: list[float], lows: list[float], closes: list[float], volumes: list[float], n: int = 20) -> float | None:
    if len(closes) < n:
        return None
    num = den = 0.0
    for i in range(len(closes) - n, len(closes)):
        tp = (highs[i] + lows[i] + closes[i]) / 3
        num += tp * volumes[i]
        den += volumes[i]
    return num / den if den else None


def mfi(highs: list[float], lows: list[float], closes: list[float], volumes: list[float], n: int = 14) -> float | None:
    """Money Flow Index (daily-bar approximation)."""
    if len(closes) < n + 1:
        return None
    pos = neg = 0.0
    for i in range(len(closes) - n, len(closes)):
        tp = (highs[i] + lows[i] + closes[i]) / 3
        prev_tp = (highs[i - 1] + lows[i - 1] + closes[i - 1]) / 3
        flow = tp * volumes[i]
        if tp > prev_tp:
            pos += flow
        elif tp < prev_tp:
            neg += flow
    if neg == 0:
        return 100.0
    return 100 - 100 / (1 + pos / neg)


def adx(highs: list[float], lows: list[float], closes: list[float], n: int = 14) -> float | None:
    """Wilder ADX as of the last bar."""
    if len(closes) < 2 * n:
        return None
    plus_dm, minus_dm, trs = [], [], []
    for i in range(1, len(closes)):
        up, dn = highs[i] - highs[i - 1], lows[i - 1] - lows[i]
        plus_dm.append(up if (up > dn and up > 0) else 0.0)
        minus_dm.append(dn if (dn > up and dn > 0) else 0.0)
        trs.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])))
    atr_n = sum(trs[:n])
    pdm_n, mdm_n = sum(plus_dm[:n]), sum(minus_dm[:n])
    dxs = []
    for i in range(n, len(trs)):
        atr_n = atr_n - atr_n / n + trs[i]
        pdm_n = pdm_n - pdm_n / n + plus_dm[i]
        mdm_n = mdm_n - mdm_n / n + minus_dm[i]
        pdi = 100 * pdm_n / atr_n if atr_n else 0.0
        mdi = 100 * mdm_n / atr_n if atr_n else 0.0
        denom = pdi + mdi
        dxs.append(100 * abs(pdi - mdi) / denom if denom else 0.0)
    if len(dxs) < n:
        return None
    adx_v = sum(dxs[:n]) / n
    for dx in dxs[n:]:
        adx_v = (adx_v * (n - 1) + dx) / n
    return adx_v


def pct_change(a: float | None, b: float | None) -> float | None:
    """(a/b - 1) * 100 with guards."""
    if a is None or b is None or b == 0:
        return None
    return (a / b - 1) * 100


def vol_zscore(volumes: list[float], n: int = 20) -> float | None:
    """Volume Z-Score over the last n bars."""
    if len(volumes) < n:
        return None
    window = volumes[-n:]
    mean = sum(window) / n
    var = sum((v - mean) ** 2 for v in window) / n
    std = math.sqrt(var)
    if std == 0:
        return 0.0
    return (volumes[-1] - mean) / std


def bb_squeeze(closes: list[float], n: int = 20, lookback: int = 60) -> float | None:
    """Ratio of current Bollinger Band width to its minimum over lookback bars.
    Values close to 1.0 indicate tight consolidation (squeeze)."""
    if len(closes) < n + lookback:
        return None
    widths = []
    for i in range(len(closes) - lookback, len(closes)):
        sub = closes[: i + 1]
        _, _, _, w = bollinger(sub, n)
        if w is not None:
            widths.append(w)
    if not widths:
        return None
    min_w = min(widths)
    if min_w == 0:
        return None
    return widths[-1] / min_w


def weekly_trend_alignment(closes: list[float], w_fast: int = 10, w_slow: int = 20) -> float | None:
    """Synthetic weekly trend using 5-bar step proxies.
    Returns (fast - slow) / slow * 100 on weekly scale."""
    if len(closes) < w_slow * 5:
        return None
    w_closes = closes[-(w_slow * 5)::5]
    if len(w_closes) < w_slow:
        return None
    fast_m = sum(w_closes[-w_fast:]) / w_fast
    slow_m = sum(w_closes[-w_slow:]) / w_slow
    return (fast_m / slow_m - 1) * 100 if slow_m else None
