"""Stock price fallback via Yahoo Finance chart API.

NSE's quote APIs are throttled (6 s/request) and partially Akamai-blocked, which
is fine for one stock on demand but not for valuing a whole portfolio. Yahoo's
public chart endpoint needs no auth and answers in ~200 ms, so it covers the
long tail of symbols that are not members of the major NSE indices.
"""

import logging
import time

import requests

from fetchers import health

logger = logging.getLogger("axewatch.yahoo")

_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
    ),
    "accept": "application/json",
}

_CACHE: dict[str, tuple[float, dict]] = {}
_TTL = 300
_MISS_CACHE_TTL = 60  # remember failures briefly so one unknown symbol isn't retried per refresh

_SEARCH_CACHE: dict[str, tuple[float, list]] = {}
_SEARCH_TTL = 1800


def history(symbol: str, rng: str = "2y") -> dict | None:
    """~2y of daily OHLCV bars, oldest first. symbol may be a stock (REL -> REL.NS)
    or an index ticker passed through verbatim (^NSEI). Cached 1 h."""
    sym = symbol.strip().upper()
    key = f"hist:{sym}:{rng}"
    ts, cached = _CACHE.get(key, (0.0, {}))
    ttl = _MISS_CACHE_TTL if cached.get("_miss") else 3600
    if cached and time.time() - ts < ttl:
        return None if cached.get("_miss") else cached
    t0 = time.time()
    # indices (^NSEI, ^INDIAVIX) take no .NS suffix; stocks do
    ticker = sym if sym.startswith("^") else f"{sym}.NS"
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
    try:
        r = requests.get(url, params={"range": rng, "interval": "1d"}, headers=_HEADERS, timeout=15)
        if r.status_code != 200:
            health.record_response("yahoo", r.status_code, time.time() - t0, _retry_after(r))
            _CACHE[key] = (time.time(), {"_miss": True})
            return None
        r.encoding = "utf-8"
        res = (r.json().get("chart") or {}).get("result") or []
        if not res:
            health.record("yahoo", ok=False, latency=time.time() - t0, status=r.status_code, neutral=True)
            _CACHE[key] = (time.time(), {"_miss": True})
            return None
        timestamps = res[0].get("timestamp") or []
        quote = ((res[0].get("indicators") or {}).get("quote") or [{}])[0]
        rows = []
        for i, ts_i in enumerate(timestamps):
            try:
                o, h, l, c, v = (
                    quote["open"][i],
                    quote["high"][i],
                    quote["low"][i],
                    quote["close"][i],
                    quote["volume"][i],
                )
            except (KeyError, IndexError, TypeError):
                continue
            if None in (o, h, l, c) or c <= 0:
                continue
            rows.append({"t": ts_i, "o": float(o), "h": float(h), "l": float(l), "c": float(c), "v": float(v or 0)})
        if len(rows) < 60:
            _CACHE[key] = (time.time(), {"_miss": True})
            return None
        health.record("yahoo", ok=True, latency=time.time() - t0, status=200)
        out = {"symbol": sym, "rows": rows}
        _CACHE[key] = (time.time(), out)
        return out
    except Exception as exc:
        logger.warning("yahoo history %s failed: %s", sym, exc)
        health.record("yahoo", ok=False, latency=time.time() - t0, error=exc)
        _CACHE[key] = (time.time(), {"_miss": True})
        return None


def _retry_after(r) -> float | None:
    v = r.headers.get("Retry-After")
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def search(query: str, limit: int = 10) -> list[dict]:
    """NSE symbol suggestions -> [{symbol, name}]. Uses Yahoo's public search
    endpoint (not NSE) so typing in the autocomplete never burns NSE budget."""
    q = query.strip().upper()
    if not q:
        return []
    entry = _SEARCH_CACHE.get(q)
    if entry and time.time() - entry[0] < _SEARCH_TTL:
        return entry[1]
    t0 = time.time()
    try:
        r = requests.get(
            "https://query1.finance.yahoo.com/v1/finance/search",
            params={"q": q, "quotesCount": limit * 2, "newsCount": 0},
            headers=_HEADERS,
            timeout=12,
        )
        if r.status_code != 200:
            health.record_response("yahoo", r.status_code, time.time() - t0, _retry_after(r))
            logger.info("yahoo search %s -> %s", q, r.status_code)
            return []
        r.encoding = "utf-8"
        quotes = (r.json() or {}).get("quotes") or []
        out: list[dict] = []
        seen: set[str] = set()
        for it in quotes:
            sym = str(it.get("symbol") or "")
            if not sym.endswith(".NS"):
                continue
            base = sym[:-3]
            if base in seen:
                continue
            seen.add(base)
            name = str(it.get("shortname") or it.get("longname") or base).strip()
            out.append({"symbol": base, "name": name})
            if len(out) >= limit:
                break
        _SEARCH_CACHE[q] = (time.time(), out)
        health.record("yahoo", ok=True, latency=time.time() - t0, status=200)
        return out
    except Exception as exc:
        logger.warning("yahoo search %s failed: %s", q, exc)
        health.record("yahoo", ok=False, latency=time.time() - t0, error=exc)
        return []


def quote(symbol: str) -> dict | None:
    """{symbol, price, prev_close, day_high, day_low} or None if unavailable."""
    sym = symbol.strip().upper()
    ts, cached = _CACHE.get(sym, (0.0, {}))
    ttl = _MISS_CACHE_TTL if cached.get("_miss") else _TTL
    if cached and time.time() - ts < ttl:
        return None if cached.get("_miss") else cached
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}.NS"
    t0 = time.time()
    try:
        r = requests.get(url, params={"range": "1mo", "interval": "1d"}, headers=_HEADERS, timeout=12)
        if r.status_code == 429:
            time.sleep(2.5)  # Yahoo edge throttles bursts; one retry after a beat
            r = requests.get(url, params={"range": "1mo", "interval": "1d"}, headers=_HEADERS, timeout=12)
        if r.status_code == 404:
            health.record("yahoo", ok=False, latency=time.time() - t0, status=404, neutral=True)
            _CACHE[sym] = (time.time(), {"_miss": True})
            return None
        if r.status_code != 200:
            health.record_response("yahoo", r.status_code, time.time() - t0, _retry_after(r))
            _CACHE[sym] = (time.time(), {"_miss": True})
            return None
        r.encoding = "utf-8"
        res = (r.json().get("chart") or {}).get("result") or []
        if not res:
            health.record("yahoo", ok=False, latency=time.time() - t0, status=r.status_code, neutral=True)
            _CACHE[sym] = (time.time(), {"_miss": True})
            return None
        meta = res[0].get("meta") or {}
        price = meta.get("regularMarketPrice")
        if price is None:
            health.record("yahoo", ok=False, latency=time.time() - t0, status=200, neutral=True)
            _CACHE[sym] = (time.time(), {"_miss": True})
            return None
        health.record("yahoo", ok=True, latency=time.time() - t0, status=200)
        closes = ((res[0].get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
        valid_closes = [c for c in closes if c is not None]
        # chartPreviousClose is the close before the whole window (a month ago),
        # NOT yesterday — day change must use the second-to-last daily close
        prev = valid_closes[-2] if len(valid_closes) >= 2 else meta.get("chartPreviousClose")
        out = {
            "symbol": sym,
            "price": float(price),
            "prev_close": float(prev) if prev is not None else None,
            "day_high": meta.get("regularMarketDayHigh"),
            "day_low": meta.get("regularMarketDayLow"),
            "week_high": max(valid_closes) if valid_closes else None,
            "week_low": min(valid_closes) if valid_closes else None,
            "source": "yahoo",
        }
        _CACHE[sym] = (time.time(), out)
        return out
    except Exception as exc:
        logger.warning("yahoo %s failed: %s", sym, exc)
        health.record("yahoo", ok=False, latency=time.time() - t0, error=exc)
        _CACHE[sym] = (time.time(), {"_miss": True})
        return None
