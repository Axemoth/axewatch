import csv
import io
import logging
import os
import time
from pathlib import Path

import requests

from fetchers import health

logger = logging.getLogger("axewatch.nse")

BASE = "https://www.nseindia.com"

BROWSER_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
    ),
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9,hi;q=0.8",
    "connection": "keep-alive",
}

REFERERS = {
    "default": f"{BASE}/market-data/live-equity-market",
    "allIndices": f"{BASE}/market-data/live-index-values",
    "option-chain-indices": f"{BASE}/option-chain",
    "marketStatus": f"{BASE}/market-data/live-equity-market",
    "equity-stock-indices": f"{BASE}/market-data/live-equity-market",
    "quote-equity": f"{BASE}/market-data/live-equity-market",
    "ipo-current-issue": f"{BASE}/market-data/all-upcoming-issues",
    "all-upcoming-issues": f"{BASE}/market-data/all-upcoming-issues",
    "ipo-detail": f"{BASE}/market-data/all-upcoming-issues",
}


class NSESession:
    def __init__(self, min_interval: float = 6.0):
        self.session = requests.Session()
        self.session.headers.update(BROWSER_HEADERS)
        self.min_interval = min_interval
        self._last_request_ts = 0.0
        self.primed_at = 0.0

    def _throttle(self) -> None:
        wait = self.min_interval - (time.time() - self._last_request_ts)
        if wait > 0:
            time.sleep(wait)
        self._last_request_ts = time.time()

    def prime(self) -> None:
        self.session.cookies.clear()
        try:
            r = self.session.get(f"{BASE}", headers=BROWSER_HEADERS, timeout=15)
            logger.info("prime status=%s cookies=%d", r.status_code, len(self.session.cookies))
        except requests.RequestException as exc:
            logger.warning("prime failed (continuing): %s", exc)
        self.primed_at = time.time()

    def _ensure_session(self) -> None:
        stale = time.time() - self.primed_at > 900
        if not self.session.cookies or stale:
            self.prime()

    def get_json(self, path: str, params: dict | None = None) -> dict:
        url = path if path.startswith("http") else f"{BASE}{path}"
        key = next((k for k in REFERERS if k in url), "default")
        headers = {**BROWSER_HEADERS, "referer": REFERERS[key]}
        self._ensure_session()
        last_exc: Exception | None = None
        t0 = time.time()
        for attempt in range(3):
            try:
                self._throttle()
                r = self.session.get(url, params=params, headers=headers, timeout=20)
                if r.status_code in (401, 403, 429):
                    logger.warning("%s -> %s, re-priming", url, r.status_code)
                    self.prime()
                    continue
                if r.status_code != 200:
                    raise RuntimeError(f"HTTP {r.status_code} for {url}")
                if "json" not in r.headers.get("content-type", ""):
                    raise ValueError(f"non-JSON content-type for {url}")
                health.record("nse", ok=True, latency=time.time() - t0, status=200)
                r.encoding = "utf-8"  # NSE omits charset; requests would guess
                return r.json()
            except Exception as exc:
                last_exc = exc
                logger.warning("attempt %d failed for %s: %s", attempt + 1, url, exc)
                time.sleep(2 ** attempt * 3)
        health.record("nse", ok=False, latency=time.time() - t0, error=last_exc)
        raise RuntimeError(f"NSE fetch failed after retries: {url}") from last_exc


_nse: NSESession | None = None


def get_nse() -> NSESession:
    global _nse
    if _nse is None:
        _nse = NSESession()
    return _nse


def market_status() -> dict:
    return get_nse().get_json("/api/marketStatus")


def all_indices() -> dict:
    return get_nse().get_json("/api/allIndices")


def gainers_losers(which: str) -> dict:
    return get_nse().get_json(f"/api/live-analysis-variations?index={which}")


def most_active(by: str = "value") -> dict:
    return get_nse().get_json("/api/live-analysis-most-active-securities", {"index": by})


def equity_quote(symbol: str) -> dict:
    return get_nse().get_json(f"/api/quote-equity?symbol={symbol.upper()}")


def equity_quote_light(symbol: str) -> dict | None:
    """Single attempt, no re-prime on failure. quote-equity 403s on some IPs and the
    full get_json retry/re-prime cycle poisons cookies the scheduler still needs."""
    s = get_nse()
    s._ensure_session()
    s._throttle()
    url = f"{BASE}/api/quote-equity?symbol={symbol.upper()}"
    try:
        r = s.session.get(url, headers={**BROWSER_HEADERS, "referer": REFERERS["quote-equity"]}, timeout=20)
    except requests.RequestException:
        return None
    if r.status_code == 200 and "json" in r.headers.get("content-type", ""):
        return r.json()
    logger.info("quote-equity light %s -> %s", symbol, r.status_code)
    return None


def index_stocks(index: str) -> dict:
    return get_nse().get_json("/api/equity-stock-indices", {"index": index})


# ---- equity symbol master (for the stock autocomplete) ----
# NSE publishes every listed company as CSV; download once a day through the
# throttled session and search locally — typing in the autocomplete must never
# hit live NSE endpoints (AGENTS.md rate budget).

_SYMBOL_MASTER_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
_SYMBOL_MASTER: list[dict] | None = None
_SYMBOL_MASTER_AT = 0.0
_SYMBOL_TTL = 86400


def _symbol_master_path() -> Path:
    return Path(os.environ.get("AXEWATCH_DB", "/data/axewatch.db")).parent / "equity_master.csv"


def _parse_master(text: str) -> list[dict]:
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        sym = (row.get("SYMBOL") or "").strip().upper()
        name = (row.get("NAME OF COMPANY") or "").strip()
        series = (row.get(" SERIES") or row.get("SERIES") or "").strip().upper()
        if not sym or not name:
            continue
        out.append({"symbol": sym, "name": name, "series": series})
    return out


def _load_symbol_master() -> list[dict] | None:
    global _SYMBOL_MASTER, _SYMBOL_MASTER_AT
    if _SYMBOL_MASTER and time.time() - _SYMBOL_MASTER_AT < _SYMBOL_TTL:
        return _SYMBOL_MASTER
    p = _symbol_master_path()
    text = None
    if p.exists():
        try:
            if time.time() - p.stat().st_mtime < _SYMBOL_TTL:
                text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = None
    if text is None:
        try:
            s = get_nse()
            s._ensure_session()
            s._throttle()
            r = s.session.get(
                _SYMBOL_MASTER_URL,
                headers={**BROWSER_HEADERS, "referer": f"{BASE}/market-data/live-equity-market"},
                timeout=30,
            )
            if r.status_code == 200 and r.text.lstrip().startswith("SYMBOL"):
                r.encoding = "utf-8"
                text = r.text
                try:
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(text, encoding="utf-8")
                except OSError:
                    pass
            else:
                logger.info("equity master fetch -> %s", r.status_code)
        except Exception as exc:
            logger.warning("equity master fetch failed: %s", exc)
    master = _parse_master(text) if text else None
    if master:
        _SYMBOL_MASTER = master
        _SYMBOL_MASTER_AT = time.time()
        return master
    return _SYMBOL_MASTER  # stale in-memory is better than nothing


def search_symbols(query: str, limit: int = 10) -> list[dict]:
    q = query.strip().upper()
    if not q:
        return []
    master = _load_symbol_master()
    if not master:
        return []
    mainline = {"EQ", "BE", "BZ"}
    scored: list[tuple[int, int, dict]] = []
    for s in master:
        sym = s["symbol"]
        name_u = s["name"].upper()
        if sym == q:
            score = 0
        elif sym.startswith(q):
            score = 1
        elif q in sym:
            score = 2
        elif q in name_u:
            score = 3
        else:
            continue
        scored.append((score, 0 if s["series"] in mainline else 1, s))
    scored.sort(key=lambda t: (t[0], t[1], len(t[2]["symbol"])))
    return [{"symbol": s["symbol"], "name": s["name"]} for _, _, s in scored[:limit]]
