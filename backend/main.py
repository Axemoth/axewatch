import os
import csv
import io
import math
import re
import time
import uuid
import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import json

import db
from fetchers import allotment as allot_fetcher
from fetchers import ipo as ipo_fetchers
from fetchers import nse as nse_fetcher
from fetchers import news as news_fetcher
from fetchers import mf as mf_fetcher
from fetchers import yahoo as yahoo_fetcher
from fetchers import health as source_health
from fetchers.gmp import _norm_name, fetch_past_performance
from scheduler import start_scheduler, refresh_market, refresh_gmp

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "AXEWATCH_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",")
    if o.strip()
]

_SUB_CACHE: dict[str, tuple[float, dict]] = {}
SUB_TTL_SECONDS = 300
_INDEX_CACHE: dict[str, tuple[float, dict]] = {}
INDEX_TTL_SECONDS = 60
_QUOTE_CACHE: dict[str, tuple[float, dict]] = {}
QUOTE_TTL_SECONDS = 60
_NEWS_CACHE: dict[str, tuple[float, dict]] = {}
NEWS_TTL_SECONDS = 900

# quote-equity is aggressively Akamai-guarded on some IPs; equity-stock-indices is not
# and carries the same OHLC/52w fields for index members. Scan majors as fallback.
_QUOTE_FALLBACK_INDICES = [
    "NIFTY 50",
    "NIFTY NEXT 50",
    "NIFTY BANK",
    "NIFTY IT",
    "NIFTY FINANCIAL SERVICES",
    "NIFTY MIDCAP 100",
    "NIFTY SMALLCAP 100",
    "NIFTY 500",
]


def _valid_symbol(symbol: str) -> str:
    key = symbol.strip().upper()
    if not re.fullmatch(r"[A-Z0-9-]{1,20}", key):
        raise HTTPException(400, "invalid symbol")
    return key


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    threading.Thread(target=refresh_market, daemon=True).start()
    threading.Thread(target=refresh_gmp, daemon=True).start()
    try:
        import predict

        predict._load_global_from_disk()
        predict.kick_global_training()  # retrains daily; loads saved weights when fresh
    except Exception as exc:
        logging.getLogger("axewatch.api").warning("global model boot failed: %s", exc)
    sched = start_scheduler()
    yield
    sched.shutdown(wait=False)


app = FastAPI(title="Axewatch API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _latest_or_404(kind: str) -> dict:
    snap = db.latest_snapshot(kind)
    if snap is None:
        raise HTTPException(503, f"no data yet for {kind}, try again shortly")
    return {"kind": kind, "fetched_at": snap["fetched_at"], "data": snap["data"]}


@app.get("/api/sources/health")
def sources_health():
    return {"kind": "source_health", "fetched_at": time.time(), "data": source_health.snapshot()}


@app.get("/api/health")
def health():
    return {"status": "ok", "ts": time.time()}


@app.get("/api/market/status")
def market_status():
    return _latest_or_404("market_status")


@app.get("/api/market/indices")
def indices():
    return _latest_or_404("all_indices")


@app.get("/api/market/gainers")
def gainers():
    return _latest_or_404("gainers")


@app.get("/api/market/losers")
def losers():
    return _latest_or_404("losers")


@app.get("/api/index/{index_name}/stocks")
def index_stocks(index_name: str):
    key = index_name.strip()
    if not key or len(key) > 60:
        raise HTTPException(400, "invalid index name")
    if key.upper() == "INDIA VIX":
        raise HTTPException(400, "INDIA VIX has no constituent stocks")
    ts, cached = _INDEX_CACHE.get(key, (0.0, None))
    fresh = time.time() - ts < INDEX_TTL_SECONDS
    if cached and fresh:
        return {"kind": "index_stocks", "index": key, "cached": True, "fetched_at": ts, "data": cached}
    try:
        data = nse_fetcher.index_stocks(key)
        _INDEX_CACHE[key] = (time.time(), data)
        return {"kind": "index_stocks", "index": key, "cached": False, "fetched_at": time.time(), "data": data}
    except Exception as exc:
        logging.getLogger("axewatch.api").warning("index stocks %s failed: %s", key, exc)
        if cached:
            return {"kind": "index_stocks", "index": key, "cached": True, "stale": True, "fetched_at": ts, "data": cached}
        raise HTTPException(502, f"could not fetch stocks for {key}")


def _quote_from_index_scan(key: str) -> dict | None:
    for idx in _QUOTE_FALLBACK_INDICES:
        ts, cached = _INDEX_CACHE.get(idx, (0.0, None))
        rows = cached if cached and time.time() - ts < INDEX_TTL_SECONDS * 5 else None
        if rows is None:
            try:
                rows = nse_fetcher.index_stocks(idx)
                _INDEX_CACHE[idx] = (time.time(), rows)
            except Exception:
                continue
        for r in (rows or {}).get("data") or []:
            if str(r.get("symbol", "")).upper() == key:
                return {
                    "symbol": key,
                    "name": r.get("companyName") or key,
                    "series": None,
                    "isin": None,
                    "last_updated": None,
                    "last_price": r.get("lastPrice"),
                    "change": r.get("change"),
                    "p_change": r.get("pChange"),
                    "open": r.get("open"),
                    "day_high": r.get("dayHigh"),
                    "day_low": r.get("dayLow"),
                    "prev_close": r.get("previousClose"),
                    "vwap": None,
                    "week_high": r.get("yearHigh"),
                    "week_low": r.get("yearLow"),
                    "total_traded_volume": r.get("totalTradedVolume"),
                    "source": "index_scan",
                }
    return None


@app.get("/api/stock/{symbol}/quote")
def stock_quote(symbol: str):
    key = _valid_symbol(symbol)
    ts, cached = _QUOTE_CACHE.get(key, (0.0, None))
    if cached and time.time() - ts < QUOTE_TTL_SECONDS:
        return {"kind": "stock_quote", "symbol": key, "cached": True, "fetched_at": ts, "data": cached}
    try:
        raw = nse_fetcher.equity_quote_light(key)
        data = None
        if raw:
            pi = raw.get("priceInfo") or {}
            intraday = pi.get("intradayHighLow") or {}
            week = pi.get("weekHighLow") or {}
            md = raw.get("metadata") or {}
            data = {
            "symbol": key,
            "name": md.get("companyName"),
            "series": md.get("series"),
            "isin": md.get("isin"),
            "last_updated": md.get("lastUpdateTime"),
            "last_price": pi.get("lastPrice") or pi.get("close"),
            "change": pi.get("change"),
            "p_change": pi.get("pChange"),
            "open": pi.get("open"),
            "day_high": intraday.get("max") or pi.get("dayHigh"),
            "day_low": intraday.get("min") or pi.get("dayLow"),
            "prev_close": pi.get("prevClose"),
            "vwap": pi.get("vwap"),
            "week_high": week.get("max"),
            "week_low": week.get("min"),
            "total_traded_volume": (
                ((raw.get("marketDeptInfo") or {}).get("orderBook") or {}).get("totalTradedVolume")
                or md.get("totalTradedVolume")
            ),
        }
        if data is None:
            raise RuntimeError("quote-equity unavailable")
        _QUOTE_CACHE[key] = (time.time(), data)
        return {"kind": "stock_quote", "symbol": key, "cached": False, "fetched_at": time.time(), "data": data}
    except Exception as exc:
        logging.getLogger("axewatch.api").warning("quote fetch %s failed: %s", key, exc)
        fb = _quote_from_index_scan(key)
        if fb is not None:
            _QUOTE_CACHE[key] = (time.time(), fb)
            return {"kind": "stock_quote", "symbol": key, "cached": False, "fetched_at": time.time(), "data": fb}
        if cached:
            return {"kind": "stock_quote", "symbol": key, "cached": True, "stale": True, "fetched_at": ts, "data": cached}
        raise HTTPException(502, f"could not fetch quote for {key}")


@app.get("/api/stock/{symbol}/news")
def stock_news(symbol: str):
    key = _valid_symbol(symbol)
    ts, cached = _NEWS_CACHE.get(key, (0.0, None))
    if cached and time.time() - ts < NEWS_TTL_SECONDS:
        return {"kind": "stock_news", "symbol": key, "cached": True, "fetched_at": ts, "data": cached}
    try:
        data = news_fetcher.stock_news(key)
        _NEWS_CACHE[key] = (time.time(), data)
        return {"kind": "stock_news", "symbol": key, "cached": False, "fetched_at": time.time(), "data": data}
    except Exception as exc:
        logging.getLogger("axewatch.api").warning("news fetch %s failed: %s", key, exc)
        if cached:
            return {"kind": "stock_news", "symbol": key, "cached": True, "stale": True, "fetched_at": ts, "data": cached}
        raise HTTPException(502, f"could not fetch news for {key}")


@app.get("/api/outlook/model")
def outlook_model_status():
    import predict

    return {"kind": "outlook_model", "fetched_at": time.time(), "data": predict.global_status()}


@app.get("/api/stock/{symbol}/outlook")
def stock_outlook(symbol: str):
    key = _valid_symbol(symbol)
    try:
        import predict

        payload = predict.outlook(key)
    except Exception as exc:
        logging.getLogger("axewatch.api").warning("outlook %s failed: %s", key, exc)
        raise HTTPException(502, f"could not build outlook for {key}")
    if payload is None:
        raise HTTPException(404, f"not enough price history for {key}")
    return {"kind": "stock_outlook", "symbol": key, "fetched_at": payload["generated_at"], "data": payload}


@app.get("/api/mf/list")
def mf_list(q: str | None = Query(default=None, max_length=80), page: int = Query(default=1, ge=1, le=10000)):
    from fetchers import mf as mf_fetcher

    data = mf_fetcher.browse(q, page, per_page=50)
    return {"kind": "mf_list", "fetched_at": time.time(), "data": data}


@app.get("/api/mf/{code}/detail")
def mf_detail(code: str):
    if not re.fullmatch(r"\d{1,8}", code.strip()):
        raise HTTPException(400, "invalid scheme code")
    from fetchers import mfholdings

    try:
        data = mfholdings.fund_detail(code.strip())
    except Exception as exc:
        logging.getLogger("axewatch.api").warning("mf detail %s failed: %s", code, exc)
        raise HTTPException(502, "could not load fund details")
    if data is None:
        raise HTTPException(404, "scheme not found")
    return {"kind": "mf_detail", "fetched_at": time.time(), "data": data}


@app.get("/api/ipo/current")
def ipo_current():
    return _latest_or_404("ipo_current")


@app.get("/api/ipo/upcoming")
def ipo_upcoming():
    return _latest_or_404("ipo_upcoming")


@app.get("/api/ipo/past")
def ipo_past(days: int = Query(default=60, le=180)):
    from datetime import date, timedelta

    to = date.today()
    frm = to - timedelta(days=days)
    perf_rows = []
    snap = db.latest_snapshot("ipo_past_perf")
    if snap:
        perf_rows = (snap["data"] or {}).get("rows") or []
    by_norm = {r["norm"]: r for r in perf_rows if r.get("norm")}

    def _num(v):
        m = re.search(r"-?\d+(?:\.\d+)?", str(v or ""))
        return float(m.group()) if m else None

    out = []
    try:
        nse_rows = nse_fetcher.get_nse().get_json(
            "/api/public-past-issues",
            {"from_date": frm.strftime("%d-%m-%Y"), "to_date": to.strftime("%d-%m-%Y")},
        )
        for raw in nse_rows if isinstance(nse_rows, list) else []:
            name = raw.get("company")
            norm = _norm_name(name or "")
            perf = by_norm.pop(norm, None) or next(
                (v for k, v in by_norm.items() if k and (k in norm or norm in k)), None
            )
            issue_p = _num(raw.get("issuePrice")) or _num((perf or {}).get("issue_price"))
            listing_p = _num((perf or {}).get("listing_price"))
            gain = None
            if issue_p and listing_p:
                gain = round((listing_p - issue_p) / issue_p * 100, 2)
            out.append(
                {
                    "symbol": raw.get("symbol"),
                    "name": name,
                    "open_date": raw.get("ipoStartDate"),
                    "close_date": raw.get("ipoEndDate"),
                    "listing_date": None if raw.get("listingDate") == "-" else raw.get("listingDate"),
                    "price_band": raw.get("priceRange"),
                    "issue_price": issue_p,
                    "gmp": (perf or {}).get("gmp"),
                    "listing_price": listing_p,
                    "listing_gain_pct": gain,
                }
            )
    except Exception as exc:
        logging.getLogger("axewatch.api").warning("past ipos fetch failed: %s", exc)

    for norm, perf in by_norm.items():
        out.append(
            {
                "symbol": None,
                "name": perf.get("name"),
                "open_date": None,
                "close_date": None,
                "listing_date": None,
                "price_band": None,
                "issue_price": _num(perf.get("issue_price")),
                "gmp": perf.get("gmp"),
                "listing_price": _num(perf.get("listing_price")),
                "listing_gain_pct": None,
            }
        )

    def sort_key(r):
        from datetime import datetime

        d = r.get("close_date") or r.get("listing_date") or ""
        try:
            return datetime.strptime(d, "%d-%b-%Y").timestamp()
        except (ValueError, TypeError):
            return 0.0

    out.sort(key=sort_key, reverse=True)

    # attach the latest recorded subscription snapshot per symbol (pure DB
    # reads — no NSE calls). Snapshots accumulate whenever anyone views an
    # issue's bidding detail, so recently-closed IPOs usually have full
    # QIB/SHNI/BHNI/NII/RII breakdowns; older ones may have none.
    def _sub_snapshot(sym: str) -> tuple[dict | None, float | None]:
        # SME issues are snapshotted under inconsistent keys ("FOO" vs
        # "FOOSME" depending on which list they came from); try variants.
        cands = [sym]
        if sym.endswith("SME"):
            cands.append(sym[:-3])
        else:
            cands.append(sym + "SME")
        for cand in cands:
            try:
                snap = db.latest_snapshot(f"sub_{cand}")
            except Exception:
                snap = None
            if snap and isinstance(snap.get("data"), dict) and snap["data"].get("total_x") is not None:
                d = snap["data"]
                return (
                    {k: d.get(k) for k in ("total_x", "qib", "nii", "shni", "bhni", "rii", "employees")},
                    snap.get("fetched_at"),
                )
        return None, None

    for r in out:
        r["sub"] = None
        r["sub_asof"] = None
        sym = (r.get("symbol") or "").strip().upper()
        if sym:
            r["sub"], r["sub_asof"] = _sub_snapshot(sym)

    return {
        "kind": "ipo_past",
        "fetched_at": time.time(),
        "data": {"count": len(out), "ipos": out},
    }


@app.get("/api/ipo/subscription/{symbol}")
def ipo_subscription_detail(symbol: str):
    key = symbol.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{1,20}", key):
        raise HTTPException(400, "invalid symbol")
    ts, cached = _SUB_CACHE.get(key, (0.0, None))
    fresh = time.time() - ts < SUB_TTL_SECONDS
    if cached and fresh:
        return {"kind": "ipo_subscription", "cached": True, "fetched_at": ts, "data": cached}
    try:
        data = ipo_fetchers.ipo_subscription(key)
        _SUB_CACHE[key] = (time.time(), data)
        db.save_snapshot(f"sub_{key}", data)
        return {"kind": "ipo_subscription", "cached": False, "fetched_at": time.time(), "data": data}
    except Exception as exc:
        logging.getLogger("axewatch.api").warning("subscription fetch %s failed: %s", key, exc)
        if cached:
            return {"kind": "ipo_subscription", "cached": True, "stale": True, "fetched_at": ts, "data": cached}
        raise HTTPException(502, f"could not fetch subscription for {key}")


@app.get("/api/ipo/{symbol}/history")
def ipo_subscription_history(symbol: str, limit: int = Query(default=200, le=1000)):
    key = symbol.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{1,20}", key):
        raise HTTPException(400, "invalid symbol")
    snaps = db.history(f"sub_{key}", limit)
    points = []
    for snap in reversed(snaps):
        d = snap["data"]
        points.append(
            {
                "t": snap["fetched_at"],
                "total_x": d.get("total_x"),
                "qib": d.get("qib"),
                "nii": d.get("nii"),
                "rii": d.get("rii"),
            }
        )
    return {
        "kind": "ipo_subscription_history",
        "fetched_at": time.time(),
        "data": {"symbol": key, "points": points},
    }


@app.get("/api/gmp/trends")
def gmp_trends(limit: int = Query(default=300, le=1000)):
    from fetchers.gmp import _gmp_value, _status_priority

    snaps = db.history("gmp", limit)
    series: dict[str, list[dict]] = {}
    status_by_name: dict[str, tuple[int, str | None]] = {}
    for snap in reversed(snaps):
        rows = (snap.get("data") or {}).get("rows") or []
        t = snap["fetched_at"]
        for row in rows:
            name = row.get("name")
            if not name:
                continue
            key = str(name).strip()
            raw = row.get("gmp") or row.get("gmp_percent")
            m = re.search(r"-?\d+(?:\.\d+)?", str(raw)) if raw is not None else None
            if m:
                val = float(m.group())
                series.setdefault(key, []).append({"t": t, "value": val})
            status = row.get("status")
            if key not in status_by_name and (status or row.get("priority") is not None):
                status_by_name[key] = (
                    row.get("priority", 9) if status else _status_priority(status),
                    status,
                )
            elif key not in status_by_name:
                status_by_name[key] = (9, None)
    out = [
        {
            "name": name,
            "status": status_by_name.get(name, (9, None))[1],
            "current": pts[-1]["value"] if pts else None,
            "first": pts[0]["value"] if pts else None,
            "trend": (
                "up" if len(pts) > 1 and pts[-1]["value"] > pts[0]["value"]
                else "down" if len(pts) > 1 and pts[-1]["value"] < pts[0]["value"]
                else "flat"
            ),
            "points": pts,
        }
        for name, pts in series.items()
    ]
    out.sort(
        key=lambda s: (
            status_by_name.get(s["name"], (9, None))[0],
            -(s["current"] or 0),
        )
    )
    return {
        "kind": "gmp_trends",
        "fetched_at": time.time(),
        "data": {"count": len(out), "series": out},
    }


@app.get("/api/gmp")
def gmp_live():
    return _latest_or_404("gmp")


@app.get("/api/history/{kind}")
def snapshot_history(kind: str, limit: int = Query(default=100, le=1000)):
    return {"kind": kind, "snapshots": db.history(kind, limit)}


@app.post("/api/admin/refresh")
def admin_refresh():
    threading.Thread(target=refresh_market, daemon=True).start()
    threading.Thread(target=refresh_gmp, daemon=True).start()
    return {"status": "refresh triggered"}


# ---- portfolio (user holdings; stored locally in SQLite, never sent anywhere) ----

_PORTFOLIO_SYMBOL_RE = re.compile(r"[A-Z0-9&\-]{1,20}")
_MF_CODE_RE = re.compile(r"\d{1,8}")
_PORTFOLIO_SUMMARY_CACHE: dict[str, tuple[float, dict]] = {}
_PORTFOLIO_SUMMARY_TTL = 60


class HoldingIn(BaseModel):
    asset_type: str
    symbol: str
    name: str | None = None
    quantity: float
    avg_price: float


class HoldingUpdate(BaseModel):
    quantity: float
    avg_price: float


class CsvImportIn(BaseModel):
    csv: str


def _portfolio_summary_cached() -> dict | None:
    ts, cached = _PORTFOLIO_SUMMARY_CACHE.get("all", (0.0, None))
    if cached and time.time() - ts < _PORTFOLIO_SUMMARY_TTL:
        return cached
    return None


def _stock_price_map(symbols: list[str]) -> dict[str, dict]:
    """Price data for many NSE symbols at once.

    Yahoo first (fast, no shared throttle, covers everything Yahoo lists) with a
    small stagger to stay under its burst limit; NSE index constituent lists
    (one throttled call each, cached) back up the symbols Yahoo misses. Per-symbol
    NSE quotes are never used here — the 6 s throttle would make a 20-stock
    portfolio take two minutes.
    """
    out: dict[str, dict] = {}
    remaining = [s for s in symbols if s]
    # circuit breaker: skip the Yahoo pass entirely while it's in cooldown
    # (index scan still covers the majors); slow down a little when degraded
    yahoo_live = source_health.is_available("yahoo")
    stagger = 1.2 if source_health.is_degraded("yahoo") else 0.4
    if yahoo_live:
        for i, sym in enumerate(remaining):
            if i:
                time.sleep(stagger)
            yq = yahoo_fetcher.quote(sym)
            if yq:
                out[sym] = {
                    "last_price": yq.get("price"),
                    "prev_price": yq.get("prev_close"),
                    "day_high": yq.get("day_high"),
                    "day_low": yq.get("day_low"),
                    "week_high": yq.get("week_high"),
                    "week_low": yq.get("week_low"),
                    "source": "yahoo",
                }
    remaining = [s for s in remaining if s not in out]
    for idx in _QUOTE_FALLBACK_INDICES:
        if not remaining:
            break
        ts, cached = _INDEX_CACHE.get(idx, (0.0, None))
        rows = cached if cached and time.time() - ts < INDEX_TTL_SECONDS * 10 else None
        if rows is None:
            try:
                rows = nse_fetcher.index_stocks(idx)
                _INDEX_CACHE[idx] = (time.time(), rows)
            except Exception:
                continue
        for r in (rows or {}).get("data") or []:
            sym = str(r.get("symbol", "")).upper()
            if sym in remaining:
                out[sym] = {
                    "last_price": r.get("lastPrice"),
                    "prev_price": r.get("previousClose"),
                    "day_high": r.get("dayHigh"),
                    "day_low": r.get("dayLow"),
                    "week_high": r.get("yearHigh"),
                    "week_low": r.get("yearLow"),
                    "source": "index_scan",
                }
        remaining = [s for s in remaining if s not in out]
    return out


def _sector_map() -> dict:
    """symbol -> industry, persisted; new symbols resolved one NSE quote at a
    time (throttled by the shared session). Cache survives restarts."""
    path = db.DB_PATH.parent / "sector_map.json"
    cache: dict = {}
    try:
        if path.exists():
            cache = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        cache = {}

    def save():
        try:
            path.write_text(json.dumps(cache), encoding="utf-8")
        except Exception:
            pass

    return cache


def _resolve_sectors(symbols: list[str], cache: dict) -> None:
    missing = [s for s in symbols if s not in cache]
    path = db.DB_PATH.parent / "sector_map.json"
    changed = False
    for s in missing[:12]:  # cap per rebuild; the rest resolve on later passes
        try:
            q = nse_fetcher.equity_quote(s)
            industry = ((q or {}).get("industry") or "Other").split(":")[-1].strip() or "Other"
            cache[s] = industry
            changed = True
        except Exception:
            break  # NSE throttling — leave the rest for a later pass
    if changed:
        try:
            path.write_text(json.dumps(cache), encoding="utf-8")
        except Exception:
            pass


def _xirr(flows: list[tuple[float, float]]) -> float | None:
    """Annualized money-weighted return via bisection. flows: (ts, amount),
    investments negative, proceeds/dividends positive. None when unsolvable."""
    if len(flows) < 2:
        return None
    has_pos = any(a > 0 for _, a in flows)
    has_neg = any(a < 0 for _, a in flows)
    if not (has_pos and has_neg):
        return None
    t0 = min(ts for ts, _ in flows)

    def npv(rate: float) -> float:
        return sum(a / (1 + rate) ** ((ts - t0) / (365.0 * 86400)) for ts, a in flows)

    lo, hi = -0.9, 10.0
    f_lo, f_hi = npv(lo), npv(hi)
    if f_lo * f_hi > 0:
        return None
    for _ in range(80):
        mid = (lo + hi) / 2
        f_mid = npv(mid)
        if abs(f_mid) < 1e-7:
            return mid
        if f_lo * f_mid < 0:
            hi, f_hi = mid, f_mid
        else:
            lo, f_lo = mid, f_mid
    return (lo + hi) / 2


def _build_portfolio_summary() -> dict:
    holdings = db.list_holdings()
    stocks = [h for h in holdings if h["asset_type"] == "stock"]
    mfs = [h for h in holdings if h["asset_type"] == "mf"]
    prices = _stock_price_map([h["symbol"] for h in stocks]) if stocks else {}

    rows: list[dict] = []
    for h in holdings:
        row = dict(h)
        invested = round(h["quantity"] * h["avg_price"], 2)
        if h["asset_type"] == "stock":
            p = prices.get(h["symbol"])
            last = (p or {}).get("last_price")
            prev = (p or {}).get("prev_price")
            row.update(
                {
                    "last_price": last,
                    "prev_price": prev,
                    "day_high": (p or {}).get("day_high"),
                    "day_low": (p or {}).get("day_low"),
                    "week_high": (p or {}).get("week_high"),
                    "week_low": (p or {}).get("week_low"),
                    "price_source": (p or {}).get("source"),
                }
            )
        else:
            nav = mf_fetcher.scheme_nav(h["symbol"])
            row.update({"last_price": nav["nav"] if nav else None, "prev_price": None, "price_source": "mfapi" if nav else None})
            if nav and not h.get("name"):
                row["name"] = nav["name"]
        value = round(h["quantity"] * row["last_price"], 2) if row.get("last_price") != None else None
        pnl = round(value - invested, 2) if value != None else None
        day_pnl = (
            round((row["last_price"] - row["prev_price"]) * h["quantity"], 2)
            if row.get("last_price") != None and row.get("prev_price") not in (None,)
            else None
        )
        row.update(
            {
                "invested": invested,
                "value": value,
                "pnl": pnl,
                "pnl_pct": round(pnl / invested * 100, 2) if pnl != None and invested else None,
                "day_pnl": day_pnl,
                "day_change_pct": (
                    round((row["last_price"] - row["prev_price"]) / row["prev_price"] * 100, 2)
                    if row.get("last_price") != None and row.get("prev_price")
                    else None
                ),
            }
        )
        rows.append(row)

    total_value = sum(r["value"] for r in rows if r["value"] != None)
    total_invested = sum(r["invested"] for r in rows)
    total_pnl = round(total_value - total_invested, 2) if total_value else None
    day_pnl_total = sum(r["day_pnl"] for r in rows if r["day_pnl"] != None) or None
    for r in rows:
        r["weight_pct"] = round(r["value"] / total_value * 100, 2) if r.get("value") and total_value else None

    by_type: dict[str, float] = {}
    for r in rows:
        if r.get("value"):
            by_type[r["asset_type"]] = round(by_type.get(r["asset_type"], 0.0) + r["value"], 2)

    stock_rows = sorted([r for r in rows if r["asset_type"] == "stock" and r.get("weight_pct") != None], key=lambda r: -(r["weight_pct"] or 0))
    top5_weight = round(sum(r["weight_pct"] or 0 for r in stock_rows[:5]), 1)

    insights: list[dict] = []
    priced = [r for r in rows if r.get("last_price") != None]
    by_pnl = sorted([r for r in priced if r.get("pnl") != None], key=lambda r: -(r["pnl"] or 0))
    if by_pnl:
        best, worst = by_pnl[0], by_pnl[-1]
        if best is not worst:
            insights.append({"kind": "best", "text": f"Best performer: {best['name'] or best['symbol']} at {best['pnl_pct']:+.1f}% ({best['pnl']:+,.0f})"})
            insights.append({"kind": "worst", "text": f"Worst performer: {worst['name'] or worst['symbol']} at {worst['pnl_pct']:+.1f}% ({worst['pnl']:+,.0f})"})
    movers = sorted([r for r in priced if r.get("day_change_pct") != None], key=lambda r: -(r["day_change_pct"] or 0))
    if len(movers) >= 2 and (movers[0]["day_change_pct"] or 0) > 0:
        insights.append({"kind": "mover", "text": f"Biggest gainer today: {movers[0]['symbol']} {movers[0]['day_change_pct']:+.1f}% · biggest drag: {movers[-1]['symbol']} {movers[-1]['day_change_pct']:+.1f}%"})
    if stock_rows and top5_weight > 50:
        insights.append({"kind": "concentration", "text": f"Your top 5 stocks are {top5_weight:.0f}% of the portfolio — a dip in any of them moves your whole portfolio. Consider spreading across more stocks or funds."})
    if stock_rows and stock_rows[0].get("weight_pct", 0) > 25:
        insights.append({"kind": "concentration", "text": f"{stock_rows[0]['symbol']} alone is {stock_rows[0]['weight_pct']:.0f}% of your portfolio — single-stock risk is high."})
    stock_val = by_type.get("stock", 0.0)
    mf_val = by_type.get("mf", 0.0)
    if stock_val and not mf_val:
        insights.append({"kind": "balance", "text": "You hold only direct stocks. Mutual funds can add diversification if you do not want to track individual companies."})
    elif mf_val and not stock_val:
        insights.append({"kind": "balance", "text": "You hold only mutual funds — fully hands-off, but you are paying expense ratios an active stock picker avoids."})
    missing = [r["symbol"] for r in rows if r.get("last_price") is None]
    if missing:
        insights.append({"kind": "data", "text": f"No live price found for: {', '.join(missing[:6])}{' and more' if len(missing) > 6 else ''}. Check the symbol."})

    stock_rows_all = [r for r in rows if r["asset_type"] == "stock"]
    smap = _sector_map()
    _resolve_sectors([r["symbol"] for r in stock_rows_all], smap)
    sector_alloc: dict[str, float] = {}
    for r in stock_rows_all:
        sec = smap.get(r["symbol"], "Other")
        sector_alloc[sec] = round(sector_alloc.get(sec, 0.0) + (r.get("value") or 0.0), 2)
    sector_alloc = {k: v for k, v in sorted(sector_alloc.items(), key=lambda kv: -kv[1]) if v > 0}

    flows: list[tuple[float, float]] = [
        (h["created_at"], -(h["quantity"] * h["avg_price"])) for h in holdings
    ]
    for d in db.list_dividends():
        flows.append((d["ts"], d["amount_total"]))
    if total_value:
        flows.append((time.time(), total_value))
    xirr = _xirr(flows)
    total_div = round(sum(d["amount_total"] for d in db.list_dividends()), 2)

    return {
        "holdings": rows,
        "totals": {
            "invested": round(total_invested, 2),
            "value": round(total_value, 2) if total_value else None,
            "pnl": total_pnl,
            "pnl_pct": round(total_pnl / total_invested * 100, 2) if total_pnl != None and total_invested else None,
            "day_pnl": round(day_pnl_total, 2) if day_pnl_total != None else None,
            "by_type": by_type,
            "count": len(rows),
            "xirr_pct": round(xirr * 100, 2) if xirr is not None else None,
            "dividends_total": total_div,
        },
        "sector_alloc": sector_alloc,
        "insights": insights,
    }


@app.get("/api/portfolio/holdings")
def portfolio_holdings():
    return {"kind": "portfolio_holdings", "fetched_at": time.time(), "data": {"holdings": db.list_holdings()}}


@app.post("/api/portfolio/holdings")
def portfolio_add(h: HoldingIn):
    if h.asset_type == "stock":
        sym = h.symbol.strip().upper()
        if not _PORTFOLIO_SYMBOL_RE.fullmatch(sym):
            raise HTTPException(400, "invalid stock symbol")
        name = (h.name or sym).strip()[:120]
    elif h.asset_type == "mf":
        sym = h.symbol.strip()
        if not _MF_CODE_RE.fullmatch(sym):
            raise HTTPException(400, "invalid mf scheme code")
        name = (h.name or "").strip()[:200]
    else:
        raise HTTPException(400, "asset_type must be 'stock' or 'mf'")
    if not (h.quantity > 0) or not (h.avg_price >= 0):
        raise HTTPException(400, "quantity must be > 0 and avg_price >= 0")
    row = db.upsert_holding(h.asset_type, sym, name, round(h.quantity, 4), round(h.avg_price, 4))
    _PORTFOLIO_SUMMARY_CACHE.pop("all", None)
    return {"kind": "portfolio_holding", "fetched_at": time.time(), "data": row}


@app.put("/api/portfolio/holdings/{holding_id}")
def portfolio_update(holding_id: int, body: HoldingUpdate):
    if not (body.quantity > 0) or not (body.avg_price >= 0):
        raise HTTPException(400, "quantity must be > 0 and avg_price >= 0")
    row = db.update_holding(holding_id, round(body.quantity, 4), round(body.avg_price, 4))
    if row is None:
        raise HTTPException(404, "holding not found")
    _PORTFOLIO_SUMMARY_CACHE.pop("all", None)
    return {"kind": "portfolio_holding", "fetched_at": time.time(), "data": row}


@app.delete("/api/portfolio/holdings/{holding_id}")
def portfolio_delete(holding_id: int):
    if not db.delete_holding(holding_id):
        raise HTTPException(404, "holding not found")
    _PORTFOLIO_SUMMARY_CACHE.pop("all", None)
    return {"kind": "portfolio_deleted", "fetched_at": time.time(), "data": {"id": holding_id}}


_SYM_COLS = {"instrument", "stock", "symbol", "company", "scrip", "security"}
_QTY_COLS = {"qty", "quantity", "units", "shares", "qty."}
_AVG_COLS = {"avg", "avgcost", "avgprice", "avg_price", "averagecost", "buyprice", "buyavg", "avgcostprice"}


def _num(cell: str) -> float | None:
    s = re.sub(r"[₹,\s]", "", str(cell or ""))
    try:
        v = float(s)
        return v if v == v else None
    except ValueError:
        return None


@app.post("/api/portfolio/import")
def portfolio_import(body: CsvImportIn):
    """Stock holdings from CSV text. Understands broker exports (e.g. Zerodha
    Console's Instrument,Qty.,Avg. cost) and a plain symbol,quantity,avg_price layout."""
    if not body.csv or len(body.csv) > 500_000:
        raise HTTPException(400, "csv body missing or too large")
    reader = csv.reader(io.StringIO(body.csv))
    raw_rows = [r for r in reader if any(c.strip() for c in r)]
    if not raw_rows:
        raise HTTPException(400, "no rows found")

    def norm(col: str) -> str:
        return re.sub(r"[^a-z]", "", (col or "").lower())

    sym_i = qty_i = avg_i = None
    for i, cell in enumerate(raw_rows[0]):
        n = norm(cell)
        if n in _SYM_COLS and sym_i is None:
            sym_i = i
        elif n in _QTY_COLS and qty_i is None:
            qty_i = i
        elif n in _AVG_COLS and avg_i is None:
            avg_i = i
    body_rows = raw_rows[1:] if sym_i is not None and qty_i is not None else raw_rows
    if sym_i is None:
        sym_i = 0
    if qty_i is None:
        qty_i = 1
    if avg_i is None:
        avg_i = 2

    added: list[dict] = []
    skipped: list[str] = []
    for r in body_rows:
        try:
            sym = r[sym_i].strip().upper()
            qty = _num(r[qty_i]) if qty_i < len(r) else None
            avg = _num(r[avg_i]) if avg_i < len(r) else None
        except IndexError:
            continue
        if not sym or qty is None or qty <= 0 or avg is None or avg < 0:
            skipped.append(",".join(r)[:80])
            continue
        if not _PORTFOLIO_SYMBOL_RE.fullmatch(sym):
            skipped.append(sym)
            continue
        added.append(db.upsert_holding("stock", sym, sym, round(qty, 4), round(avg, 4)))
    _PORTFOLIO_SUMMARY_CACHE.pop("all", None)
    return {
        "kind": "portfolio_import",
        "fetched_at": time.time(),
        "data": {"added": len(added), "holdings": added, "skipped": skipped[:50]},
    }


@app.get("/api/portfolio/mf/search")
def portfolio_mf_search(q: str = Query(min_length=3, max_length=80)):
    return {"kind": "mf_search", "fetched_at": time.time(), "data": {"results": mf_fetcher.search_schemes(q)}}


@app.get("/api/portfolio/stock/search")
def portfolio_stock_search(q: str = Query(min_length=1, max_length=40)):
    # NSE equity master first (local, instant); Yahoo only if the master is unavailable
    results = nse_fetcher.search_symbols(q)
    if not results and len(q.strip()) >= 2:
        results = yahoo_fetcher.search(q)
    return {"kind": "stock_search", "fetched_at": time.time(), "data": {"results": results}}


@app.get("/api/portfolio/summary")
def portfolio_summary():
    cached = _portfolio_summary_cached()
    if cached:
        return {"kind": "portfolio_summary", "cached": True, "fetched_at": cached["ts"], "data": cached["summary"]}
    summary = _build_portfolio_summary()
    _PORTFOLIO_SUMMARY_CACHE["all"] = (time.time(), {"ts": time.time(), "summary": summary})
    return {"kind": "portfolio_summary", "cached": False, "fetched_at": time.time(), "data": summary}


# ---- paper trading (simulated fills at live prices; local SQLite only) ----

PAPER_ORDER_TTL = 0  # fills are immediate market orders


class PaperOrderIn(BaseModel):
    side: str
    symbol: str
    name: str | None = None
    quantity: float


class LimitOrderIn(BaseModel):
    side: str
    symbol: str
    name: str | None = None
    quantity: float
    limit_price: float


class DividendIn(BaseModel):
    symbol: str
    amount_total: float
    ex_date: str | None = None
    note: str | None = None


class PanIn(BaseModel):
    label: str | None = None
    pan: str


class AllotCheckIn(BaseModel):
    pan_id: int
    issue_key: str | None = None


class AllotBulkIn(BaseModel):
    pan_ids: list[int] | None = None
    issue_keys: list[str] | None = None


class ManualIn(BaseModel):
    pan_id: int
    issue_key: str
    outcome: str
    shares: int | None = None


def _execute_paper_fill(side: str, sym: str, qty: float, price: float, name: str | None = None) -> dict:
    """Apply a filled market order to cash + positions. Raises on validation."""
    price = round(price, 2)
    acct = db.paper_account_row()
    pos = db.paper_position(sym)
    realized = None

    if side == "BUY":
        cost = qty * price
        if cost > acct["cash"] + 1e-9:
            raise HTTPException(400, f"insufficient cash: need ₹{cost:,.0f}, have ₹{acct['cash']:,.0f}")
        if pos:
            total_qty = pos["quantity"] + qty
            new_avg = (pos["quantity"] * pos["avg_price"] + cost) / total_qty
            db.paper_upsert_position(sym, name or pos["name"], total_qty, new_avg, pos["realized_pnl"])
        else:
            db.paper_upsert_position(sym, name or sym, qty, price, 0.0)
        db.paper_set_cash(acct["cash"] - cost)
    else:
        if not pos or pos["quantity"] + 1e-9 < qty:
            have = pos["quantity"] if pos else 0
            raise HTTPException(400, f"not enough shares: tried to sell {qty:g}, hold {have:g}")
        realized = round((price - pos["avg_price"]) * qty, 2)
        remaining = round(pos["quantity"] - qty, 4)
        if remaining <= 1e-9:
            db.paper_delete_position(sym)
        else:
            db.paper_upsert_position(sym, pos["name"], remaining, pos["avg_price"], pos["realized_pnl"] + realized)
        db.paper_set_cash(acct["cash"] + qty * price)

    return db.paper_add_order(side, sym, qty, price, realized)


_PAPER_CACHE: dict[str, tuple[float, dict]] = {}
_PAPER_TTL = 30


def _paper_account_payload(price_map: dict | None = None) -> dict:
    acct = db.paper_account_row()
    positions = db.paper_positions()
    symbols = [p["symbol"] for p in positions]
    prices = price_map if price_map is not None else (_stock_price_map(symbols) if symbols else {})
    rows, invested, value_total = [], 0.0, 0.0
    for p in positions:
        px = (prices.get(p["symbol"]) or {}).get("last_price")
        value = round(p["quantity"] * px, 2) if px else None
        invested += p["quantity"] * p["avg_price"]
        if value:
            value_total += value
        pnl = round(value - p["quantity"] * p["avg_price"], 2) if value else None
        rows.append(
            {
                **p,
                "last_price": px,
                "value": value,
                "pnl": pnl,
                "pnl_pct": round(pnl / (p["quantity"] * p["avg_price"]) * 100, 2)
                if pnl is not None and p["avg_price"]
                else None,
                "day_change_pct": None,
            }
        )
    equity = round(acct["cash"] + value_total, 2)
    try:
        db.log_paper_equity(equity, acct["cash"], value_total)
    except Exception:
        pass
    return {
        "cash": round(acct["cash"], 2),
        "starting_cash": acct["starting_cash"],
        "invested": round(invested, 2),
        "positions_value": round(value_total, 2),
        "equity": equity,
        "total_return_pct": round((equity / acct["starting_cash"] - 1) * 100, 2),
        "realized_pnl": round(sum(p.get("realized_pnl") or 0 for p in positions), 2),
        "positions": rows,
        "orders": db.paper_orders(20),
        "limit_orders": db.recent_limit_orders(15),
    }


@app.get("/api/paper/account")
def paper_account():
    ts, cached = _PAPER_CACHE.get("all", (0.0, None))
    if cached and time.time() - ts < _PAPER_TTL:
        return {"kind": "paper_account", "cached": True, "fetched_at": ts, "data": cached}
    payload = _paper_account_payload()
    _PAPER_CACHE["all"] = (time.time(), payload)
    return {"kind": "paper_account", "cached": False, "fetched_at": time.time(), "data": payload}


@app.get("/api/paper/equity-history")
def paper_equity_history():
    return {
        "kind": "paper_equity_history",
        "fetched_at": time.time(),
        "data": {"points": db.paper_equity_history(150)},
    }


@app.post("/api/paper/order")
def paper_order(o: PaperOrderIn):
    side = o.side.strip().upper()
    if side not in ("BUY", "SELL"):
        raise HTTPException(400, "side must be BUY or SELL")
    sym = o.symbol.strip().upper()
    if not _PORTFOLIO_SYMBOL_RE.fullmatch(sym):
        raise HTTPException(400, "invalid symbol")
    qty = round(o.quantity, 4)
    if not (qty > 0):
        raise HTTPException(400, "quantity must be > 0")

    prices = _stock_price_map([sym])
    price = (prices.get(sym) or {}).get("last_price")
    if not price or price <= 0:
        raise HTTPException(502, f"no live price available for {sym}; try again")

    order = _execute_paper_fill(side, sym, qty, round(price, 2), o.name)
    _PAPER_CACHE.pop("all", None)
    _IDEAS_CACHE.pop("all", None)
    return {
        "kind": "paper_order",
        "fetched_at": time.time(),
        "data": {"order": order, "cash": round(db.paper_account_row()["cash"], 2)},
    }


@app.post("/api/paper/limit-order")
def paper_limit_order(o: LimitOrderIn):
    side = o.side.strip().upper()
    if side not in ("BUY", "SELL"):
        raise HTTPException(400, "side must be BUY or SELL")
    sym = o.symbol.strip().upper()
    if not _PORTFOLIO_SYMBOL_RE.fullmatch(sym):
        raise HTTPException(400, "invalid symbol")
    if not (o.quantity > 0) or not (o.limit_price > 0):
        raise HTTPException(400, "quantity and limit_price must be > 0")
    row = db.add_limit_order(side, sym, (o.name or sym)[:60], round(o.quantity, 4), o.limit_price)
    _PAPER_CACHE.pop("all", None)
    _IDEAS_CACHE.pop("all", None)
    return {"kind": "paper_limit_order", "fetched_at": time.time(), "data": row}


@app.delete("/api/paper/limit-order/{order_id}")
def paper_limit_cancel(order_id: int):
    if not db.cancel_limit_order(order_id):
        raise HTTPException(404, "open limit order not found")
    _PAPER_CACHE.pop("all", None)
    _IDEAS_CACHE.pop("all", None)
    return {"kind": "paper_limit_cancelled", "fetched_at": time.time(), "data": {"id": order_id}}


@app.post("/api/paper/reset")
def paper_reset():
    row = db.paper_reset()
    _PAPER_CACHE.pop("all", None)
    _IDEAS_CACHE.pop("all", None)
    return {"kind": "paper_reset", "fetched_at": time.time(), "data": row}


# ---- signal tracker ----


@app.get("/api/signals")
def signals():
    rows = db.recent_signals(60)
    resolved = [r for r in rows if r["resolved"] and r["outcome"] in ("hit_target_1", "hit_stop", "expired")]
    wins = [r for r in resolved if r["outcome"] == "hit_target_1"]
    losses = [r for r in resolved if r["outcome"] == "hit_stop"]
    exp = [r for r in resolved if r["outcome"] == "expired"]
    exp_wins = [r for r in exp if (r["r_multiple"] or 0) > 0]
    all_wins = wins + exp_wins
    total_r = sum(r["r_multiple"] or 0 for r in resolved)

    win_r_sum = sum(r["r_multiple"] or 0 for r in all_wins)
    loss_r_sum = sum(abs(r["r_multiple"] or 0) for r in losses)
    profit_factor = round(win_r_sum / loss_r_sum, 2) if loss_r_sum > 0 else (round(win_r_sum, 2) if win_r_sum > 0 else None)
    avg_win_r = round(win_r_sum / len(all_wins), 2) if all_wins else None
    avg_loss_r = round(sum(r["r_multiple"] or 0 for r in losses) / len(losses), 2) if losses else None

    return {
        "kind": "signals",
        "fetched_at": time.time(),
        "data": {
            "open": [r for r in rows if not r["resolved"] and r["outcome"] is None],
            "recent": rows,
            "stats": {
                "resolved": len(resolved),
                "wins": len(all_wins),
                "losses": len(losses),
                "expired": len(exp),
                "win_rate_pct": round(len(all_wins) / len(resolved) * 100, 1) if resolved else None,
                "total_r": round(total_r, 2) if resolved else None,
                "avg_r": round(total_r / len(resolved), 2) if resolved else None,
                "profit_factor": profit_factor,
                "avg_win_r": avg_win_r,
                "avg_loss_r": avg_loss_r,
            },
        },
    }


# ---- trade ideas (model signals + live price + risk sizing) ----

_IDEAS_CACHE: dict[str, tuple[float, dict]] = {}
_IDEAS_TTL = 90
_IDEAS_RISK_TIERS = (0.5, 1.0, 2.0)
_IDEAS_MAX = 20


def _build_trade_ideas() -> dict:
    """Open model signals enriched for one-click paper trading.

    Prices come from the Yahoo-first chain (never the throttled per-symbol NSE
    quote), one combined map for ideas + paper positions. Sizes answer "how
    many shares risk X% of my paper equity if the stop hits". SELL ideas are
    exit-only (paper accounts can't short), so their size is capped at shares
    held and flagged when there is nothing to sell.
    """
    rows = db.recent_signals(80)
    open_rows = [r for r in rows if not r["resolved"] and r["outcome"] is None]
    seen: set[str] = set()
    latest: list[dict] = []
    for r in sorted(open_rows, key=lambda x: x["planned_at"], reverse=True):
        if r["symbol"] in seen:
            continue
        seen.add(r["symbol"])
        latest.append(r)
    latest.sort(key=lambda r: abs(r["score"] or 0), reverse=True)
    latest = latest[:_IDEAS_MAX]

    positions = {p["symbol"]: p for p in db.paper_positions()}
    symbols = list(dict.fromkeys([r["symbol"] for r in latest] + list(positions)))
    prices = _stock_price_map(symbols)

    acct = db.paper_account_row()
    value_total = 0.0
    for sym, p in positions.items():
        px = (prices.get(sym) or {}).get("last_price")
        if px:
            value_total += p["quantity"] * px
    equity = round(acct["cash"] + value_total, 2)
    now = time.time()

    ideas = []
    for r in latest:
        entry, stop = r["entry"], r["stop"]
        risk = abs(entry - stop) if entry and stop and entry > 0 else None
        live = (prices.get(r["symbol"]) or {}).get("last_price")
        src = (prices.get(r["symbol"]) or {}).get("source")
        t1, t2 = r["target_1"], r["target_2"]
        rr = None
        if risk and t1 and entry:
            move = (t1 - entry) if r["signal"] == "BUY" else (entry - t1)
            rr = round(move / risk, 2)
        pos = positions.get(r["symbol"]) or {}
        held = pos.get("quantity") or 0
        tiers = []
        for pct in _IDEAS_RISK_TIERS:
            budget = equity * pct / 100
            qty = math.floor(budget / risk) if risk and risk > 0 else 0
            if r["signal"] == "SELL":
                qty = min(qty, math.floor(held))
            tiers.append(
                {
                    "risk_pct": pct,
                    "qty": qty,
                    "notional": round(qty * live, 2) if live and qty else None,
                    "max_loss": round(qty * risk, 2) if risk and qty else None,
                }
            )
        can_trade = True
        block_reason = None
        if live is None:
            can_trade = False
            block_reason = "no live price right now"
        elif r["signal"] == "SELL" and held <= 0:
            can_trade = False
            block_reason = "SELL exits a position — you hold no shares"
        elif r["signal"] == "BUY" and risk and math.floor(equity * 0.5 / 100 / risk) < 1:
            can_trade = False
            block_reason = "risk per share exceeds the 0.5% budget"
        ideas.append(
            {
                "symbol": r["symbol"],
                "signal": r["signal"],
                "score": round(r["score"], 1) if r["score"] is not None else None,
                "entry": entry,
                "live": live,
                "drift_pct": round((live / entry - 1) * 100, 2) if live and entry else None,
                "stop": stop,
                "stop_pct": round(abs(stop / entry - 1) * 100, 2) if stop and entry else None,
                "target_1": t1,
                "target_2": t2,
                "reward_risk": rr,
                "risk_per_share": round(risk, 2) if risk else None,
                "horizon_days": r["horizon_days"],
                "planned_at": r["planned_at"],
                "age_days": round((now - r["planned_at"]) / 86400, 1),
                "price_source": src,
                "held_qty": held,
                "held_avg": pos.get("avg_price"),
                "tiers": tiers,
                "can_trade": can_trade,
                "block_reason": block_reason,
            }
        )
    return {
        "equity": equity,
        "cash": round(acct["cash"], 2),
        "starting_cash": acct["starting_cash"],
        "risk_tiers": list(_IDEAS_RISK_TIERS),
        "count": len(ideas),
        "ideas": ideas,
    }


@app.get("/api/trades/ideas")
def trade_ideas():
    ts, cached = _IDEAS_CACHE.get("all", (0.0, None))
    if cached and time.time() - ts < _IDEAS_TTL:
        return {"kind": "trade_ideas", "cached": True, "fetched_at": ts, "data": cached}
    payload = _build_trade_ideas()
    _IDEAS_CACHE["all"] = (time.time(), payload)
    return {"kind": "trade_ideas", "cached": False, "fetched_at": time.time(), "data": payload}


# ---- IPO allotment (PAN vault + registrar checks) ----
# Privacy: full PANs never leave the server except inside the registrar lookup
# itself. All API responses and logs carry masked PANs only.

_ALLOT_ISSUES_CACHE: dict[str, tuple[float, list]] = {}
_ALLOT_ISSUES_TTL = 6 * 3600
_ALLOT_JOBS: dict[str, dict] = {}
_ALLOT_JOBS_LOCK = threading.Lock()


def _parse_allot_date(s: str | None) -> float | None:
    if not s:
        return None
    from datetime import datetime

    for fmt in ("%d-%b-%Y", "%d-%B-%Y", "%d-%m-%Y", "%Y-%m-%d", "%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(s.strip(), fmt).timestamp()
        except (ValueError, TypeError):
            continue
    return None


def _allotment_candidates(allow_live: bool = True) -> list[dict]:
    """Active + recently-closed IPOs worth checking. Cached 6h (1 NSE call).

    allow_live=False serves the cache (or an empty list) without touching the
    network — used by the results endpoint so cached outcomes always render
    instantly even with a cold backend.
    """
    ts, cached = _ALLOT_ISSUES_CACHE.get("all", (0.0, None))
    if cached and time.time() - ts < _ALLOT_ISSUES_TTL:
        return cached
    if not allow_live:
        return list(cached or [])
    out: list[dict] = []
    seen: set[str] = set()

    def add(symbol, name, open_date, close_date, state):
        key = (symbol or "").strip().upper() or ("n:" + allot_fetcher.canon_ipo_name(name or ""))
        if not key or key in seen:
            return
        seen.add(key)
        close_ts = _parse_allot_date(close_date)
        expected = None
        if close_ts:
            from datetime import datetime

            expected = datetime.fromtimestamp(close_ts + 5 * 86400).strftime("%d-%b-%Y")
        out.append(
            {
                "key": key,
                "symbol": (symbol or "").strip().upper() or None,
                "name": name,
                "open_date": open_date,
                "close_date": close_date,
                "expected_allotment": expected,
                "state": state,
            }
        )

    try:
        snap = db.latest_snapshot("ipo_current")
        for r in ((snap["data"] or {}).get("ipos") or []) if snap else []:
            add(r.get("symbol"), r.get("name"), r.get("open_date"), r.get("close_date"), "active")
    except Exception as exc:
        logging.getLogger("axewatch.api").warning("allot candidates current failed: %s", exc)
    try:
        from datetime import date, timedelta

        to = date.today()
        frm = to - timedelta(days=60)
        rows = nse_fetcher.get_nse().get_json(
            "/api/public-past-issues",
            {"from_date": frm.strftime("%d-%m-%Y"), "to_date": to.strftime("%d-%m-%Y")},
        )
        cutoff = time.time() - 45 * 86400
        for raw in rows if isinstance(rows, list) else []:
            close_ts = _parse_allot_date(raw.get("ipoEndDate"))
            if close_ts is not None and close_ts < cutoff:
                continue
            add(raw.get("symbol"), raw.get("company"), raw.get("ipoStartDate"), raw.get("ipoEndDate"), "closed")
    except Exception as exc:
        logging.getLogger("axewatch.api").warning("allot candidates past failed: %s", exc)

    _ALLOT_ISSUES_CACHE["all"] = (time.time(), out)
    try:
        directory = allot_fetcher.registrar_directory()
    except Exception as exc:
        logging.getLogger("axewatch.api").warning("registrar directory failed: %s", exc)
        directory = {}
    for issue in out:
        hit = allot_fetcher.attribute_registrar(
            issue.get("name") or issue.get("symbol"), directory)
        issue["registrar"] = (hit or {}).get("registrar")
        issue["registrar_name"] = (hit or {}).get("name")
        # Declared allotment dates beat the close+5 estimate wherever the
        # directory knows them.
        if (hit or {}).get("allotment_date"):
            ts = _parse_allot_date(hit["allotment_date"])
            if ts:
                from datetime import datetime

                issue["expected_allotment"] = datetime.fromtimestamp(ts).strftime("%d-%b-%Y")
    return out


def _match_mufg_company(issue: dict, companies: list[dict]) -> dict | None:
    """Best MUFG company for an issue: exact canon match, then substring."""
    want = allot_fetcher.canon_ipo_name(issue.get("name") or issue.get("symbol"))
    if not want:
        return None
    cands = [(allot_fetcher.canon_ipo_name(c.get("name")), c) for c in companies]
    for canon, c in cands:
        if canon and canon == want:
            return c
    for canon, c in cands:
        if canon and want and (canon in want or want in canon):
            return c
    return None


def _records_outcome(records: list[dict]) -> tuple[str, int | None, int | None]:
    """Outcome from registrar application records.

    Records with shares allotted -> "allotted". Records with shares applied
    but zero allotted -> "not_allotted" (entered the lottery, lost it) — this
    is materially different from "not_applied" (no application on record),
    which is what an empty result set means.
    """
    if not records:
        return ("not_applied", None, None)
    tot_applied = sum(r.get("applied") or 0 for r in records)
    tot_allotted = sum(r.get("allotted") or 0 for r in records)
    if tot_allotted > 0:
        return ("allotted", tot_applied or None, tot_allotted)
    if tot_applied > 0:
        return ("not_allotted", tot_applied, 0)
    return ("not_applied", None, None)


def _store_allot_row(pan_id: int, issue: dict, source: str, outcome: str,
                     applied: int | None = None, allotted: int | None = None,
                     amask: str | None = None, error: str | None = None) -> dict:
    db.allot_upsert(pan_id, issue["key"], issue.get("name") or "", source,
                    outcome, applied, allotted, amask, error)
    return {"source": source, "outcome": outcome, "shares_applied": applied,
            "shares_allotted": allotted, "applicant_mask": amask,
            "error": error, "checked_at": time.time()}


def _compose_allot(pan_id: int, pan_mask: str, issue: dict, rows: list[dict]) -> dict:
    """One issue result from per-source outcome rows (rows already persisted)."""
    real = [r for r in rows if r.get("outcome") != "uncovered"]
    allotted_rows = [r for r in real if r.get("outcome") == "allotted"]
    tried_rows = [r for r in real if r.get("outcome") in ("allotted", "not_allotted")]
    if allotted_rows:
        overall = "allotted"
        shares = max(r.get("shares_allotted") or 0 for r in allotted_rows)
        applied = max([r.get("shares_applied") or 0 for r in tried_rows] or [0]) or None
    elif any(r.get("outcome") == "not_allotted" for r in real):
        overall = "not_allotted"
        shares = 0
        applied = max([r.get("shares_applied") or 0 for r in tried_rows] or [0]) or None
    elif real and all(r.get("outcome") == "error" for r in real):
        overall = "error"
        shares, applied = None, None
    elif not real:
        # No registrar made a definitive query for this issue.  Do not label
        # that as "not applied": KFintech has no issue directory and the
        # other RTAs may be outside our automated coverage.
        overall = "uncovered"
        shares, applied = None, None
    else:
        overall = "not_applied"
        shares, applied = None, None
    note = None
    if overall == "uncovered":
        if issue.get("registrar") == "bigshare":
            note = "Bigshare requires verification on its official page — use the one-click manual check below"
        else:
            note = "Automated coverage is not confirmed for this IPO — use the registrar links below for a manual check"
    elif overall in ("not_applied", "not_allotted"):
        if issue.get("registrar") == "bigshare" and overall == "not_applied":
            bs_row = next((r for r in rows if r.get("source") == "bigshare"), None)
            if bs_row and bs_row.get("outcome") == "not_applied":
                note = "checked on Bigshare — no application on record"
            elif bs_row and bs_row.get("outcome") == "error":
                note = f"Bigshare check paused ({bs_row.get('error')}) — use manual check below"
            else:
                note = "handled by Bigshare — use the manual check below"
        else:
            close_ts = _parse_allot_date(issue.get("close_date"))
            if issue.get("state") == "active" or (close_ts and time.time() - close_ts < 2 * 86400):
                note = "allotment may not be declared yet"
            elif close_ts and time.time() - close_ts > 21 * 86400:
                note = "older issues rotate off registrar sites — also check your broker app or CDSL/NSDL statements"
    return {
        "pan_id": pan_id,
        "pan_mask": pan_mask,
        "issue_key": issue["key"],
        "issue_name": issue.get("name"),
        "symbol": issue.get("symbol"),
        "registrar": issue.get("registrar"),
        "registrar_name": issue.get("registrar_name"),
        "close_date": issue.get("close_date"),
        "expected_allotment": issue.get("expected_allotment"),
        "state": issue.get("state"),
        "overall": overall,
        "shares_allotted": shares,
        "shares_applied": applied,
        "note": note,
        "sources": [
            {
                "source": r.get("source"),
                "outcome": r.get("outcome"),
                "shares_applied": r.get("shares_applied"),
                "shares_allotted": r.get("shares_allotted"),
                "applicant_mask": r.get("applicant_mask"),
                "error": r.get("error"),
                "checked_at": r.get("checked_at"),
            }
            for r in rows
        ],
    }


def _check_pan_issues(pan_id: int, pan: str, issues: list[dict]) -> list[dict]:
    """Run one PAN across issues. KFintech once per PAN; MUFG per matched company.

    MUFG coverage comes from the live dropdown PLUS remembered company IDs, so
    issues that rotated off the dropdown stay checkable. Issues covered by
    neither get an explicit "uncovered" row instead of a misleading silence.
    """
    from fetchers import health as _health

    MUFG_CALL_CAP = 12
    mask = allot_fetcher.mask_pan(pan)
    kfin_records: list[dict] | None = None
    if _health.is_available("allot_kfin"):
        try:
            res = allot_fetcher.kfin_check(pan)
            kfin_records = res.get("records") if res.get("found") else []
        except allot_fetcher.AllotmentTransient as exc:
            kfin_records = None
            kfin_error = str(exc)[:160]
        else:
            kfin_error = None
    else:
        kfin_error = "KFintech cooling down, try later"

    try:
        mufg_cos = allot_fetcher.mufg_companies() if _health.is_available("allot_mufg") else []
    except allot_fetcher.AllotmentTransient:
        mufg_cos = []
    mufg_down = not _health.is_available("allot_mufg") and not mufg_cos
    mem_ids = allot_fetcher.remembered_mufg_ids()
    mufg_calls = 0
    mufg_session = None  # one warmed session shared by all MUFG lookups in this run
    bigshare_mem_ids = allot_fetcher.remembered_bigshare_ids()

    def mufg_target_for(issue: dict) -> dict | None:
        match = _match_mufg_company(issue, mufg_cos) if mufg_cos else None
        if match:
            return match
        want = allot_fetcher.canon_ipo_name(issue.get("name") or issue.get("symbol"))
        mem = mem_ids.get(want) if want else None
        if mem and mem.get("id"):
            return {"id": mem["id"], "name": mem.get("name", ""), "remembered": True}
        return None

    def bigshare_target_for(issue: dict) -> dict | None:
        if issue.get("registrar") != "bigshare" and issue.get("registrar") is not None:
            return None
        cid = issue.get("registrar_company_id")
        if cid and issue.get("registrar") == "bigshare":
            return {"id": cid, "name": issue.get("name", "")}
        want = allot_fetcher.canon_ipo_name(issue.get("name") or issue.get("symbol"))
        mem = bigshare_mem_ids.get(want) if want else None
        if mem and mem.get("id"):
            return {"id": mem["id"], "name": mem.get("name", "")}
        return None

    def kfin_mine(issue: dict) -> list[dict]:
        want = allot_fetcher.canon_ipo_name(issue.get("name") or issue.get("symbol"))
        return [r for r in (kfin_records or [])
                if r.get("company") and want and
                (allot_fetcher.canon_ipo_name(r["company"]) == want
                 or allot_fetcher.canon_ipo_name(r["company"]) in want
                 or want in allot_fetcher.canon_ipo_name(r["company"]))]

    results = []
    for issue in issues:
        rows: list[dict] = []
        # MUFG per matched company (live list first, remembered IDs after)
        target = mufg_target_for(issue) if not mufg_down else None
        if target and not issue.get("registrar"):
            # The directory can be temporarily incomplete while the separate
            # MUFG dropdown still gives us an authoritative match.
            issue["registrar"] = "mufg"
        if target and mufg_calls < MUFG_CALL_CAP:
            mufg_calls += 1
            try:
                if mufg_session is None:
                    mufg_session = allot_fetcher.mufg_session()
                res = allot_fetcher.mufg_check(pan, target["id"], target["name"],
                                               session=mufg_session)
            except allot_fetcher.AllotmentTransient as exc:
                mufg_session = None  # stale session may be the cause; next lookup rewarms
                rows.append(_store_allot_row(pan_id, issue, "mufg", "error",
                                             error=str(exc)[:160]))
            else:
                if res.get("found"):
                    recs = res.get("records") or []
                    outcome, ta, tl = _records_outcome(recs)
                    name0 = (recs[0].get("name") or "") if recs else ""
                    amask = (name0[:4] + "***") if name0 else None
                    rows.append(_store_allot_row(pan_id, issue, "mufg", outcome, ta, tl, amask))
                else:
                    rows.append(_store_allot_row(pan_id, issue, "mufg", "not_applied"))
        elif mufg_down and not target:
            rows.append({"source": "mufg", "outcome": "error", "shares_applied": None,
                         "shares_allotted": None, "applicant_mask": None,
                         "error": "MUFG cooling down, try later", "checked_at": time.time()})
        elif not target:
            rows.append(_store_allot_row(pan_id, issue, "mufg", "uncovered"))
        # Bigshare deliberately protects result lookups with a CAPTCHA.  Do
        # not turn that into a fragile automated/OCR request: surface an
        # explicit manual handoff instead, while MUFG and KFintech remain
        # fully automated and retain their definitive outcomes.
        bs_target = bigshare_target_for(issue)
        if bs_target:
            rows.append(_store_allot_row(pan_id, issue, "bigshare", "uncovered",
                                         error="Manual CAPTCHA verification required"))
        elif issue.get("registrar") == "bigshare":
            rows.append(_store_allot_row(pan_id, issue, "bigshare", "uncovered",
                                         error="Issue not listed in Bigshare's current directory"))
        # KFintech returns only positive PAN matches, not a registrar directory.
        # Therefore an absent record is evidence of "not applied" only for an
        # issue known to be handled by KFintech; for an un-attributed issue it
        # must remain uncovered instead of becoming a misleading negative.
        if kfin_records is None:
            rows.append({"source": "kfin", "outcome": "error", "shares_applied": None,
                          "shares_allotted": None, "applicant_mask": None,
                          "error": kfin_error or "KFintech unavailable", "checked_at": time.time()})
        else:
            mine = kfin_mine(issue)
            if mine:
                if not issue.get("registrar"):
                    issue["registrar"] = "kfin"
                outcome, ta, tl = _records_outcome(mine)
                rows.append(_store_allot_row(pan_id, issue, "kfin", outcome, ta, tl))
            elif issue.get("registrar") == "kfin":
                rows.append(_store_allot_row(pan_id, issue, "kfin", "not_applied"))
            else:
                rows.append(_store_allot_row(pan_id, issue, "kfin", "uncovered"))
        results.append(_compose_allot(pan_id, mask, issue, rows))
    # KFintech records for companies outside our candidate set surface as extras
    if kfin_records:
        known = {allot_fetcher.canon_ipo_name(i.get("name") or i.get("symbol")) for i in issues}
        grouped: dict[str, list[dict]] = {}
        for r in kfin_records:
            canon = allot_fetcher.canon_ipo_name(r.get("company"))
            if not canon or canon in known:
                continue
            grouped.setdefault(canon, []).append(r)
        for canon, recs in grouped.items():
            outcome, ta, tl = _records_outcome(recs)
            if outcome == "not_applied":
                continue
            extra_issue = {"key": f"kfin:{canon}", "name": recs[0].get("company"),
                           "symbol": None, "close_date": None,
                           "expected_allotment": None, "state": "closed"}
            results.append(_compose_allot(pan_id, mask, extra_issue, [
                _store_allot_row(pan_id, extra_issue, "kfin", outcome, ta, tl)]))
    return results


def _bulk_worker(job_id: str, pan_ids: list[int], issues: list[dict]) -> None:
    total = len(pan_ids) * max(len(issues), 1)
    try:
        for pid in pan_ids:
            row = db.pan_get(pid)
            if not row:
                with _ALLOT_JOBS_LOCK:
                    _ALLOT_JOBS[job_id]["done"] += len(issues)
                continue
            with _ALLOT_JOBS_LOCK:
                _ALLOT_JOBS[job_id]["current"] = allot_fetcher.mask_pan(row["pan"])
            try:
                res = _check_pan_issues(pid, row["pan"], issues)
            except Exception as exc:
                logging.getLogger("axewatch.api").warning("allot bulk pan %d failed: %s", pid, exc)
                res = []
            with _ALLOT_JOBS_LOCK:
                job = _ALLOT_JOBS[job_id]
                job["results"].extend(res)
                job["done"] += len(issues)
        with _ALLOT_JOBS_LOCK:
            _ALLOT_JOBS[job_id]["state"] = "done"
            _ALLOT_JOBS[job_id]["current"] = None
    except Exception as exc:
        with _ALLOT_JOBS_LOCK:
            _ALLOT_JOBS[job_id]["state"] = "failed"
            _ALLOT_JOBS[job_id]["error"] = str(exc)[:200]


@app.get("/api/allotment/pans")
def allot_pans():
    return {
        "kind": "allotment_pans",
        "fetched_at": time.time(),
        "data": {
            "pans": [
                {"id": r["id"], "label": r["label"] or f"PAN {r['id']}",
                 "masked": allot_fetcher.mask_pan(r["pan"]), "created_at": r["created_at"]}
                for r in db.pan_list()
            ]
        },
    }


@app.post("/api/allotment/pans")
def allot_pan_add(body: PanIn):
    pan = (body.pan or "").strip().upper()
    if not allot_fetcher.valid_pan(pan):
        raise HTTPException(400, "invalid PAN (format: ABCDE1234F)")
    try:
        row = db.pan_add(body.label or "", pan)
    except Exception:
        raise HTTPException(409, "that PAN is already saved")
    return {
        "kind": "allotment_pan",
        "fetched_at": time.time(),
        "data": {"id": row["id"], "label": row["label"] or f"PAN {row['id']}",
                 "masked": allot_fetcher.mask_pan(pan), "created_at": row["created_at"]},
    }


@app.delete("/api/allotment/pans/{pan_id}")
def allot_pan_delete(pan_id: int):
    if not db.pan_delete(pan_id):
        raise HTTPException(404, "PAN not found")
    return {"kind": "allotment_pan_deleted", "fetched_at": time.time(), "data": {"id": pan_id}}


@app.get("/api/allotment/issues")
def allot_issues():
    issues = _allotment_candidates()
    return {"kind": "allotment_issues", "fetched_at": time.time(),
            "data": {"count": len(issues), "issues": issues}}


@app.get("/api/allotment/links")
def allot_links():
    return {"kind": "allotment_links", "fetched_at": time.time(),
            "data": {"links": allot_fetcher.MANUAL_LINKS}}


@app.get("/api/allotment/registrars")
def allot_registrars():
    d = allot_fetcher.registrar_directory()
    by_registrar: dict[str, int] = {}
    for v in d.values():
        by_registrar[v["registrar"]] = by_registrar.get(v["registrar"], 0) + 1
    return {"kind": "allotment_registrars", "fetched_at": time.time(),
            "data": {"count": len(d), "by_registrar": by_registrar}}


@app.get("/api/allotment/results")
def allot_results(pan_id: int | None = None):
    rows = db.allot_results(pan_id)
    by_issue: dict[tuple, dict] = {}
    for r in rows:
        key = (r["pan_id"], r["issue_key"])
        by_issue.setdefault(key, {"pan_id": r["pan_id"], "issue_key": r["issue_key"],
                                  "issue_name": r["issue_name"], "rows": []})
        by_issue[key]["rows"].append(r)
    pans = {r["id"]: r for r in db.pan_list()}
    # fast path: never block cached results on a live NSE/directory refresh
    candidates = _allotment_candidates(allow_live=False)
    warm_dir = allot_fetcher.directory_if_warm() or {}
    out = []
    for (pid, _), g in by_issue.items():
        prow = pans.get(pid)
        if not prow:
            continue
        issue = next((i for i in candidates if i["key"] == g["issue_key"]),
                     {"key": g["issue_key"], "name": g["issue_name"], "symbol": None,
                      "close_date": None, "expected_allotment": None, "state": "closed"})
        if not issue.get("registrar"):
            hit = allot_fetcher.attribute_registrar(
                issue.get("name") or g["issue_name"], warm_dir)
            if hit:
                issue = {**issue, "registrar": hit.get("registrar"),
                         "registrar_name": hit.get("name")}
        if not issue.get("registrar") and any(
                r.get("source") == "kfin" and r.get("outcome") in ("allotted", "not_allotted")
                for r in g["rows"]):
            # KFintech returned real application records for this issue — that
            # is direct evidence it handles it, no directory needed.
            issue = {**issue, "registrar": "kfin"}
        out.append(_compose_allot(pid, allot_fetcher.mask_pan(prow["pan"]), issue, g["rows"]))
    out.sort(key=lambda r: (r["pan_id"], r["issue_name"] or ""))
    return {"kind": "allotment_results", "fetched_at": time.time(), "data": {"results": out}}


@app.post("/api/allotment/check")
def allot_check(body: AllotCheckIn):
    row = db.pan_get(body.pan_id)
    if not row:
        raise HTTPException(404, "PAN not found")
    issues = _allotment_candidates()
    if body.issue_key:
        issues = [i for i in issues if i["key"] == body.issue_key]
        if not issues:
            raise HTTPException(404, "issue not found")
    if len(issues) > 12:
        raise HTTPException(400, "too many issues for a live check — use check-all")
    results = _check_pan_issues(body.pan_id, row["pan"], issues)
    return {"kind": "allotment_check", "fetched_at": time.time(), "data": {"results": results}}


@app.post("/api/allotment/check-all")
def allot_bulk(body: AllotBulkIn):
    pans = db.pan_list()
    if body.pan_ids:
        pans = [p for p in pans if p["id"] in set(body.pan_ids)]
    if not pans:
        raise HTTPException(400, "no PANs saved yet")
    issues = _allotment_candidates()
    if body.issue_keys:
        issues = [i for i in issues if i["key"] in set(body.issue_keys)]
    if not issues:
        raise HTTPException(400, "no issues to check")
    job_id = uuid.uuid4().hex[:12]
    with _ALLOT_JOBS_LOCK:
        _ALLOT_JOBS[job_id] = {"state": "running", "total": len(pans) * len(issues),
                               "done": 0, "current": None, "results": [],
                               "error": None, "started_at": time.time()}
        # keep only recent jobs
        for jid in [j for j in _ALLOT_JOBS if j != job_id][:20]:
            _ALLOT_JOBS.pop(jid, None)
    threading.Thread(target=_bulk_worker,
                     args=(job_id, [p["id"] for p in pans], issues), daemon=True).start()
    return {"kind": "allotment_job", "fetched_at": time.time(),
            "data": {"job_id": job_id, "total": len(pans) * len(issues)}}


@app.get("/api/allotment/job/{job_id}")
def allot_job(job_id: str):
    with _ALLOT_JOBS_LOCK:
        job = _ALLOT_JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "job not found")
        snapshot = {"state": job["state"], "total": job["total"], "done": job["done"],
                    "current": job["current"], "results": list(job["results"]),
                    "error": job["error"], "started_at": job["started_at"]}
    return {"kind": "allotment_job", "fetched_at": time.time(), "data": snapshot}


def _recompose_issue(pan_id: int, pan_mask: str, issue_key: str) -> dict:
    """Rebuild one issue result from stored rows (used after manual edits)."""
    rows = [r for r in db.allot_results(pan_id) if r["issue_key"] == issue_key]
    issue = next((i for i in _allotment_candidates() if i["key"] == issue_key),
                 {"key": issue_key, "name": None, "symbol": None,
                  "close_date": None, "expected_allotment": None, "state": "closed"})
    if rows and not issue.get("name"):
        issue = {**issue, "name": rows[0].get("issue_name")}
    return _compose_allot(pan_id, pan_mask, issue, rows)


@app.post("/api/allotment/manual")
def allot_manual(body: ManualIn):
    """Log a hand-checked result (captcha-walled registrars). The user is
    ground truth here: a manual row participates in the overall verdict."""
    row = db.pan_get(body.pan_id)
    if not row:
        raise HTTPException(404, "PAN not found")
    if body.outcome not in ("allotted", "not_allotted"):
        raise HTTPException(400, "outcome must be allotted or not_allotted")
    shares = None
    if body.outcome == "allotted":
        if not body.shares or body.shares <= 0:
            raise HTTPException(400, "shares required when allotted")
        shares = body.shares
    issue = next((i for i in _allotment_candidates() if i["key"] == body.issue_key), None)
    db.allot_upsert(body.pan_id, body.issue_key,
                    (issue or {}).get("name") or "", "manual",
                    body.outcome, None, shares)
    return {"kind": "allotment_manual", "fetched_at": time.time(),
            "data": {"result": _recompose_issue(
                body.pan_id, allot_fetcher.mask_pan(row["pan"]), body.issue_key)}}


@app.delete("/api/allotment/manual")
def allot_manual_clear(pan_id: int, issue_key: str):
    row = db.pan_get(pan_id)
    if not row:
        raise HTTPException(404, "PAN not found")
    db.allot_delete_source(pan_id, issue_key, "manual")
    return {"kind": "allotment_manual_cleared", "fetched_at": time.time(),
            "data": {"result": _recompose_issue(
                pan_id, allot_fetcher.mask_pan(row["pan"]), issue_key)}}


# ---- candles / announcements / fii-dii ----


@app.get("/api/stock/{symbol}/candles")
def stock_candles(symbol: str, range: str = Query(default="1y")):
    sym = symbol.strip().upper()
    if not _PORTFOLIO_SYMBOL_RE.fullmatch(sym):
        raise HTTPException(400, "invalid symbol")
    allowed = {"6mo": "6mo", "1y": "1y", "3y": "3y", "5y": "5y"}
    rng = allowed.get(range)
    if not rng:
        raise HTTPException(400, "range must be one of 6mo, 1y, 3y, 5y")
    try:
        hist = yahoo_fetcher.history(sym, rng)
    except Exception as exc:
        raise HTTPException(502, f"candle fetch failed: {exc}")
    if not hist:
        raise HTTPException(502, f"no history available for {sym}")
    return {"kind": "candles", "fetched_at": time.time(), "data": {"symbol": sym, "range": rng, "bars": hist["rows"]}}


_ANN_CACHE: dict[str, tuple[float, dict]] = {}
_ANN_TTL = 3600


@app.get("/api/stock/{symbol}/announcements")
def stock_announcements(symbol: str):
    sym = symbol.strip().upper()
    if not _PORTFOLIO_SYMBOL_RE.fullmatch(sym):
        raise HTTPException(400, "invalid symbol")
    ts, cached = _ANN_CACHE.get(sym, (0.0, None))
    if cached and time.time() - ts < _ANN_TTL:
        return {"kind": "announcements", "cached": True, "fetched_at": ts, "data": cached}
    try:
        rows = nse_fetcher.get_nse().get_json(
            "/api/corporate-announcements", {"index": "equities", "symbol": sym}
        )
    except Exception as exc:
        raise HTTPException(502, f"announcements fetch failed: {exc}")
    rows = rows if isinstance(rows, list) else []
    out = []
    for r in rows[:12]:
        out.append(
            {
                "date": r.get("an_dt"),
                "headline": (r.get("desc") or "")[:220],
                "file": r.get("attchmntFile"),
            }
        )
    _ANN_CACHE[sym] = (time.time(), out)
    return {"kind": "announcements", "cached": False, "fetched_at": time.time(), "data": out}


@app.get("/api/fiidii")
def fiidii():
    snap = db.latest_snapshot("fiidii")
    if snap and time.time() - snap["fetched_at"] < 6 * 3600:
        return {"kind": "fiidii", "fetched_at": snap["fetched_at"], "data": snap["data"]}
    from scheduler import fetch_fiidii

    fetch_fiidii()
    snap = db.latest_snapshot("fiidii")
    if snap is None:
        raise HTTPException(502, "FII/DII data unavailable right now")
    return {"kind": "fiidii", "fetched_at": snap["fetched_at"], "data": snap["data"]}


# ---- dividends ----


@app.get("/api/portfolio/dividends")
def dividends_list():
    return {"kind": "dividends", "fetched_at": time.time(), "data": {"dividends": db.list_dividends()}}


@app.post("/api/portfolio/dividends")
def dividends_add(d: DividendIn):
    sym = d.symbol.strip().upper()
    if not _PORTFOLIO_SYMBOL_RE.fullmatch(sym):
        raise HTTPException(400, "invalid symbol")
    if not (d.amount_total > 0):
        raise HTTPException(400, "amount must be > 0")
    row = db.add_dividend(sym, d.amount_total, d.ex_date, (d.note or "")[:120] or None)
    _PORTFOLIO_SUMMARY_CACHE.pop("all", None)
    return {"kind": "dividend", "fetched_at": time.time(), "data": row}


@app.delete("/api/portfolio/dividends/{div_id}")
def dividends_delete(div_id: int):
    if not db.delete_dividend(div_id):
        raise HTTPException(404, "dividend not found")
    _PORTFOLIO_SUMMARY_CACHE.pop("all", None)
    return {"kind": "dividend_deleted", "fetched_at": time.time(), "data": {"id": div_id}}


# ---- SSE stream: pushes cached snapshot freshness (zero extra NSE calls) ----


@app.get("/api/stream")
async def stream():
    import asyncio

    async def gen():
        while True:
            kinds = {}
            with db.get_conn() as conn:
                rows = conn.execute(
                    "SELECT kind, MAX(fetched_at) AS ts FROM snapshots "
                    "WHERE kind IN ('market_status','all_indices','gainers','losers',"
                    "'ipo_current','ipo_upcoming','gmp','fiidii') GROUP BY kind"
                ).fetchall()
            for r in rows:
                kinds[r["kind"]] = r["ts"]
            yield f"data: {json.dumps({'kinds': kinds, 'server_ts': time.time()})}\n\n"
            await asyncio.sleep(12)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
