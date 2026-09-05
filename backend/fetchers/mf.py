"""Mutual fund scheme search + NAV lookup via the public mfapi.in API.

Chosen deliberately: free, no API key, no auth, no rate-limit trouble, and it is
NOT NSE — so it never eats into the Akamai bot budget (see AGENTS.md rate rules).

mfapi's /mf/search only matches whole words, so "sbi blue chip" finds nothing
(the fund is spelled "Bluechip"). We download the full scheme master once a day,
cache it on disk, and search locally with substring-per-word matching instead.
"""

import json
import logging
import os
import time
from pathlib import Path

import requests

from fetchers import health

logger = logging.getLogger("axewatch.mf")

_BASE = "https://api.mfapi.in"
_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
    ),
    "accept": "application/json",
}

_MASTER_TTL = 86400
_master_cache: list[dict] | None = None
_master_loaded_at = 0.0

_NAV_CACHE: dict[str, tuple[float, dict]] = {}
_NAV_TTL = 1800


def _master_path() -> Path:
    return Path(os.environ.get("AXEWATCH_DB", "/data/axewatch.db")).parent / "mf_master.json"


def _load_master() -> list[dict] | None:
    global _master_cache, _master_loaded_at
    if _master_cache and time.time() - _master_loaded_at < _MASTER_TTL:
        return _master_cache
    p = _master_path()
    fresh_disk = False
    if p.exists():
        try:
            age = time.time() - p.stat().st_mtime
            fresh_disk = age < _MASTER_TTL
            if fresh_disk:
                _master_cache = json.loads(p.read_text(encoding="utf-8"))
                _master_loaded_at = time.time()
                return _master_cache
        except Exception as exc:
            logger.warning("mf master disk cache unreadable: %s", exc)
    try:
        r = requests.get(f"{_BASE}/mf", headers=_HEADERS, timeout=30)
        r.encoding = "utf-8"
        if r.status_code == 200:
            raw = r.json()
            master = [
                {"code": str(s.get("schemeCode") or ""), "name": (s.get("schemeName") or "").strip()}
                for s in raw
                if s.get("schemeCode") and s.get("schemeName")
            ]
            _master_cache = master
            _master_loaded_at = time.time()
            try:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(master, ensure_ascii=False), encoding="utf-8")
            except Exception as exc:
                logger.warning("mf master cache write failed: %s", exc)
            return master
        logger.info("mf master fetch -> %s", r.status_code)
    except Exception as exc:
        logger.warning("mf master fetch failed: %s", exc)
    if _master_cache:
        return _master_cache  # stale in-memory is better than nothing
    return None


def search_schemes(query: str, limit: int = 12) -> list[dict]:
    q = query.strip().lower()
    if len(q) < 3:
        return []
    words = [w for w in q.split() if len(w) >= 3]
    if not words:
        return []
    master = _load_master()
    if master is None:
        return []
    scored: list[tuple[int, int, int, dict]] = []
    for s in master:
        name_l = s["name"].lower()
        matched = sum(1 for w in words if w in name_l)
        if matched < len(words):
            continue
        contiguous = q in name_l
        has_junk = "-idf" in name_l or "— idle" in name_l  # mfapi master keeps dead/idle rows
        score = (0 if contiguous else 1) + (1 if has_junk else 0)
        scored.append((0, score, len(s["name"]), s))
    if not scored:
        # strict AND found nothing (renamed funds do this, e.g. SBI Bluechip ->
        # "SBI Long Term Equity Fund") — fall back to best partial matches
        for s in master:
            name_l = s["name"].lower()
            matched = sum(1 for w in words if w in name_l)
            if matched == 0:
                continue
            scored.append((1, -matched, len(s["name"]), s))
        scored.sort(key=lambda t: (t[0], t[1], t[2]))
        return [s for _, _, _, s in scored[:limit]]
    scored.sort(key=lambda t: (t[0], t[1], t[2]))
    return [s for _, _, _, s in scored[:limit]]


def _get(url: str, params: dict | None = None) -> dict | list | None:
    t0 = time.time()
    try:
        r = requests.get(url, params=params, headers=_HEADERS, timeout=15)
        if r.status_code == 404:
            health.record("mfapi", ok=False, latency=time.time() - t0, status=404, neutral=True)
            logger.info("mfapi %s -> 404", url)
            return None
        if r.status_code != 200:
            health.record("mfapi", ok=False, latency=time.time() - t0, status=r.status_code, error=f"HTTP {r.status_code}")
            logger.info("mfapi %s -> %s", url, r.status_code)
            return None
        r.encoding = "utf-8"
        out = r.json()
        health.record("mfapi", ok=True, latency=time.time() - t0, status=200)
        return out
    except Exception as exc:
        health.record("mfapi", ok=False, latency=time.time() - t0, error=exc)
        logger.warning("mfapi %s failed: %s", url, exc)
        return None


def browse(query: str | None = None, page: int = 1, per_page: int = 50) -> dict:
    """Paginated scheme listing over the cached master (optionally filtered).
    50 per page by default; ~38k schemes total."""
    master = _load_master() or []
    if query and query.strip():
        words = [w for w in query.strip().lower().split() if len(w) >= 3]
        if words:
            strict = [s for s in master if all(w in s["name"].lower() for w in words)]
            if strict:
                master = strict
                master.sort(key=lambda s: len(s["name"]))
            else:
                # renamed funds (e.g. "sbi bluechip" -> "SBI Long Term Equity
                # Fund") match no full phrase — fall back to partial matches
                scored = []
                for s in master:
                    name_l = s["name"].lower()
                    hits = sum(1 for w in words if w in name_l)
                    if hits:
                        scored.append((-hits, len(s["name"]), s))
                scored.sort(key=lambda t: (t[0], t[1]))
                master = [s for _, _, s in scored]
    else:
        words = []
    total = len(master)
    pages = max(1, (total + per_page - 1) // per_page)
    page = max(1, min(page, pages))
    start = (page - 1) * per_page
    return {
        "items": master[start : start + per_page],
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": pages,
    }


def scheme_nav(code: str) -> dict | None:
    """Latest NAV for an mfapi schemeCode -> {code, name, nav, date}."""
    key = str(code).strip()
    ts, cached = _NAV_CACHE.get(key, (0.0, {}))
    if cached and time.time() - ts < _NAV_TTL:
        return cached or None
    raw = _get(f"{_BASE}/mf/{key}")
    out: dict | None = None
    if isinstance(raw, dict):
        meta = raw.get("meta") or {}
        data = raw.get("data") or []
        if data:
            latest = data[0]
            out = {
                "code": key,
                "name": (meta.get("scheme_name") or "").strip(),
                "nav": float(latest.get("nav")),
                "date": latest.get("date"),
            }
    if out:
        _NAV_CACHE[key] = (time.time(), out)
    return out
