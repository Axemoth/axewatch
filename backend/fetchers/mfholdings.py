"""Per-fund detail: NAV + asset allocation (equity/debt/cash), cached daily.

NAV, category and fund house come from mfapi.in. The equity/debt/cash split
comes from the fund's moneycontrol page, where it is embedded server-side in
Next.js data (__NEXT_DATA__) — one request, no JS execution needed. Fund ->
moneycontrol mapping uses their public autosuggest.

Per-stock holdings are NOT available from any free reachable source (they load
via client-side APIs); the UI says so and shows the allocation instead. The
"does it have a debt / FD part" question is answered exactly by bond_alloc +
cash_alloc. Everything is cached on disk for a day (holdings rotate monthly).
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path

import requests

from fetchers import health, mf

logger = logging.getLogger("axewatch.mfholdings")

_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
    ),
    "accept": "application/json, text/html",
}

_TTL = 86400
_LOOKUP_CACHE: dict[str, tuple[float, dict | None]] = {}
_FIVE_PAISA_CACHE: dict[str, tuple[float, list | None]] = {}


def _name_to_slug(name: str) -> str:
    s = name.lower()
    s = s.replace("- direct plan -", "- direct -").replace("- regular plan -", "- regular -")
    s = s.replace("direct plan", "direct").replace("regular plan", "regular")
    s = s.replace("(g)", "").replace("growth option", "growth")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    if not s.endswith("growth") and "idcw" not in s and "dividend" not in s:
        s += "-growth"
    return s


_VARIANT_WORDS = [
    "half-yearly", "quarterly", "monthly", "annual", "weekly", "daily",
    "idcw-p", "idcw", "payout", "income", "cum", "bonus", "reinvestment",
    "reinvest", "inc", "dist", "dividend", "option", "(g)", "(idcw)",
]


def _slug_candidates(name: str) -> list[str]:
    """Primary slug first, then plan-variant fallbacks. IDCW/Dividend plans hold the
    SAME portfolio as their Growth twin, so when the variant page is missing we can
    legitimately show the Growth plan's holdings."""
    primary = _name_to_slug(name)
    out = [primary]
    # strip every variant marker, then re-derive: "... - Monthly IDCW" -> "-growth"
    cleaned = " " + name.lower() + " "
    for w in _VARIANT_WORDS:
        cleaned = cleaned.replace(" " + w + " ", " ").replace(w, " ")
    base = _name_to_slug(re.sub(r"\s+", " ", cleaned).strip(" -"))
    if base not in out:
        out.append(base)
    # last resort: drop the plan word entirely (fund family page)
    family = re.sub(r"-(direct|regular)-growth$", "", base)
    if family != base and family + "-growth" not in out:
        out.append(family + "-growth")
    return [s for s in out if s]


def five_paisa_holdings(name: str) -> list[dict] | None:
    """Top holdings from the fund's 5paisa page (server-rendered HTML).
    Works for equity funds (stock + %) and debt funds (GSEC/TBILL/repo rows)."""
    if not name:
        return None
    slugs = _slug_candidates(name)
    cache_key = slugs[0]
    ts, cached = _FIVE_PAISA_CACHE.get(cache_key, (0.0, None))
    if cached and time.time() - ts < _TTL:
        return cached or None
    if not cached and cache_key in _FIVE_PAISA_CACHE and time.time() - _FIVE_PAISA_CACHE[cache_key][0] < 600:
        return None  # recent miss; don't retry every request
    for slug in slugs:
        url = f"https://www.5paisa.com/mutual-funds/{slug}"
        t0 = time.time()
        try:
            r = requests.get(url, headers=_HEADERS, timeout=20)
            if r.status_code == 404:
                # a missing variant page is "not found", not a source failure
                health.record("5paisa", ok=False, latency=time.time() - t0, status=404, neutral=True)
                continue
            if r.status_code != 200:
                health.record("5paisa", ok=False, latency=time.time() - t0, status=r.status_code, error=f"HTTP {r.status_code}")
                continue
            r.encoding = "utf-8"
            pairs = re.findall(r'<a[^>]*>([A-Za-z0-9 &.\-()]+)</a>\s*-\s*(\d+(?:\.\d+)?)%', r.text)
            seen: set[str] = set()
            out: list[dict] = []
            for stock, pct in pairs:
                n = stock.strip()
                if not n or n.lower() in seen:
                    continue
                seen.add(n.lower())
                out.append({"name": n, "pct": float(pct)})
                if len(out) >= 10:
                    break
            if not out:
                health.record("5paisa", ok=False, latency=time.time() - t0, status=200, neutral=True)
                continue
            health.record("5paisa", ok=True, latency=time.time() - t0, status=200)
            _FIVE_PAISA_CACHE[cache_key] = (time.time(), out)
            return out
        except Exception as exc:
            health.record("5paisa", ok=False, latency=time.time() - t0, error=exc)
            continue
    _FIVE_PAISA_CACHE[cache_key] = (time.time(), None)
    return None


def _cache_dir() -> Path:
    return Path(os.environ.get("AXEWATCH_DB", "/data/axewatch.db")).parent / "mf_details"


def _mc_fund_lookup(name: str) -> dict | None:
    """moneycontrol scheme name -> {slug, mfid} via public autosuggest."""
    q = re.sub(r"\s+", " ", name).strip()
    if not q:
        return None
    ts, cached = _LOOKUP_CACHE.get(q, (0.0, None))
    if cached and time.time() - ts < _TTL:
        return cached
    if not cached and q in _LOOKUP_CACHE and time.time() - _LOOKUP_CACHE[q][0] < 600:
        return None  # recent negative result; don't re-query every request
    t0 = time.time()
    try:
        r = requests.get(
            "https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php",
            params={"classic": "true", "query": q[:60], "type": "2"},
            headers=_HEADERS,
            timeout=15,
        )
        if r.status_code != 200:
            health.record("moneycontrol", ok=False, latency=time.time() - t0, status=r.status_code, error=f"HTTP {r.status_code}")
            _LOOKUP_CACHE[q] = (time.time(), None)
            return None
        r.encoding = "utf-8"
        m = re.search(r'href="https://www\.moneycontrol\.com/mutual-funds/nav/([^/]+)/([A-Z0-9]+)"', r.text)
        health.record("moneycontrol", ok=True, latency=time.time() - t0, status=200)
        if not m:
            _LOOKUP_CACHE[q] = (time.time(), None)
            return None
        out = {"slug": m.group(1), "mfid": m.group(2)}
        _LOOKUP_CACHE[q] = (time.time(), out)
        return out
    except Exception as exc:
        health.record("moneycontrol", ok=False, latency=time.time() - t0, error=exc)
        _LOOKUP_CACHE[q] = (time.time(), None)
        return None


def _mc_allocation(slug: str, mfid: str) -> dict | None:
    """Fetch the moneycontrol fund page and pull the asset allocation from
    its embedded __NEXT_DATA__ JSON."""
    url = f"https://www.moneycontrol.com/mutual-funds/nav/{slug}/{mfid}"
    t0 = time.time()
    try:
        r = requests.get(url, headers=_HEADERS, timeout=20)
        if r.status_code != 200:
            health.record("moneycontrol", ok=False, latency=time.time() - t0, status=r.status_code, error=f"HTTP {r.status_code}")
            return None
        r.encoding = "utf-8"
        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.S)
        if not m:
            health.record("moneycontrol", ok=False, latency=time.time() - t0, status=200, error="no NEXT_DATA")
            return None
        data = json.loads(m.group(1)).get("props", {}).get("pageProps", {}).get("data", {})
        ov = data.get("overview") or {}
        alloc = ov.get("assetAllocation") or {}
        health.record("moneycontrol", ok=True, latency=time.time() - t0, status=200)
        out = {
            "equity": _f(alloc.get("equity_alloc")),
            "debt": _f(alloc.get("bond_alloc")),
            "cash": _f(alloc.get("cash_alloc")),
            "other": _f(alloc.get("other_alloc")),
            "category": _s(ov.get("fundType")) or _s(ov.get("categoryName")),
            "sub_category": _s(ov.get("subCategoryName")),
        }
        if out["equity"] is None and out["debt"] is None and out["cash"] is None:
            return None
        return out
    except Exception as exc:
        health.record("moneycontrol", ok=False, latency=time.time() - t0, error=exc)
        logger.warning("mc allocation %s failed: %s", mfid, exc)
        return None


def _f(v) -> float | None:
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _s(v) -> str | None:
    s = str(v or "").strip()
    return s or None


def scheme_navs(code: str) -> dict | None:
    """mfapi /mf/{code}: latest + previous NAV, category, fund house."""
    raw = mf._get(f"https://api.mfapi.in/mf/{code}")
    if not isinstance(raw, dict):
        return None
    meta = raw.get("meta") or {}
    data = raw.get("data") or []
    if not data:
        return None
    try:
        nav = float(data[0]["nav"])
    except (KeyError, TypeError, ValueError):
        return None
    prev = None
    if len(data) > 1:
        try:
            prev = float(data[1]["nav"])
        except (KeyError, TypeError, ValueError):
            prev = None
    return {
        "code": str(code),
        "name": _s(meta.get("scheme_name")),
        "category": _s(meta.get("scheme_category")),
        "fund_house": _s(meta.get("fund_house")),
        "nav": nav,
        "nav_prev": prev,
        "nav_date": _s(data[0].get("date")),
    }


def fund_detail(code: str) -> dict | None:
    """NAV + allocation + top holdings for one scheme; disk-cached for a day."""
    key = str(code).strip()
    p = _cache_dir() / f"{key}.json"
    if p.exists():
        try:
            blob = json.loads(p.read_text(encoding="utf-8"))
            if blob.get("_v") == 2 and time.time() - p.stat().st_mtime < _TTL:
                return blob
        except (OSError, json.JSONDecodeError):
            pass

    base = scheme_navs(key)
    if base is None:
        return None
    out = {**base, "alloc": None, "alloc_source": None, "top_holdings": None, "holdings_source": None, "_v": 2}
    name = base.get("name") or ""
    lookup = _mc_fund_lookup(name)
    if lookup:
        alloc = _mc_allocation(lookup["slug"], lookup["mfid"])
        if alloc:
            out["alloc"] = alloc
            out["alloc_source"] = "moneycontrol"
    holdings = five_paisa_holdings(name)
    if holdings:
        out["top_holdings"] = holdings
        out["holdings_source"] = "5paisa"
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        logger.warning("mf detail cache write failed: %s", exc)
    return out
