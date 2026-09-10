"""IPO allotment status by PAN.

Automated sources (no captcha — reverse-engineered and tested live):
- MUFG Intime (Link Intime): company list via IPO.aspx/GetDetails, AES-token
  PAN search via IPO.aspx/SearchOnPan. Full round-trip verified against the
  live site (unknown PANs return an empty result set).
- KFintech API: GET .../prod/api/query?type=pan with reqparam=<PAN> and
  client_id headers. HTTP 200 carries records (All_Shares/App_Shares/...);
  HTTP 400 means no record for that PAN. The success path is inferred from
  their JS bundle (no real applicant PAN has been available to test), so
  KFintech hits are reported as-found.

Captcha-walled (deep links only, see MANUAL_LINKS): BSE (captcha + Akamai
wall), Bigshare (server-verified captcha), NSE (Akamai wall).

Etiquette: ≥1.5 s between calls per source, on-demand only (never in the
scheduler), Retry-After honored, everything health-tracked.

PRIVACY: PANs are sensitive PII. They are NEVER written to logs — use
mask_pan() anywhere a PAN could surface.
"""

from __future__ import annotations

import base64
import html
import json
import logging
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

from fetchers import health

logger = logging.getLogger("axewatch.allotment")

MUFG_BASE = "https://in.mpms.mufg.com/Initial_Offer/"
MUFG_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
)
# MUFG's own page encrypts the server token with this hardcoded key/iv
# (CryptoJS, visible in their public-issues.html source).
_MUFG_AES_KEY = b"8080808080808080"

KFIN_URL = "https://0uz601ms56.execute-api.ap-south-1.amazonaws.com/prod/api/query"

MANUAL_LINKS = [
    {"label": "BSE — application status", "url": "https://www.bseindia.com/investors/appli_check"},
    {"label": "NSE — verify IPO bids", "url": "https://www.nseindia.com/invest/check-trades-bids-verify-ipo-bids"},
    {"label": "Bigshare (captcha)", "url": "https://ipo.bigshareonline.com/ipo_status.html"},
    {"label": "MUFG Intime", "url": "https://in.mpms.mufg.com/Initial_Offer/public-issues.html"},
    {"label": "KFintech", "url": "https://ipostatus.kfintech.com/"},
    {"label": "Skyline", "url": "https://www.skylinerta.com/ipo.php"},
    {"label": "Cameo", "url": "https://ipostatus.cameoindia.com/"},
    {"label": "Maashitla", "url": "https://maashitla.com/allotment-status"},
    {"label": "Purva Sharegistry", "url": "https://www.purvashare.com/investor-service/ipo-query"},
    {"label": "Beetal Financial", "url": "https://www.beetalfinancial.com/"},
]

BIGSHARE_STATUS_URLS = [
    "https://ipo.bigshareonline.com/ipo_status.html",
    "https://ipo1.bigshareonline.com/ipo_status.html",
    "https://ipo2.bigshareonline.com/ipo_status.html",
]

PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")


def canon_ipo_name(name: str | None) -> str:
    """Join key between NSE/MUFG/KFintech issue names. Mirrors the frontend
    normIpoName: concatenate alphanumerics, then strip corporate suffixes,
    country tags and glued status words from the tail."""
    s = re.sub(r"[^a-z0-9]", "", (name or "").lower().replace("&", " and "))
    for _ in range(4):
        before = s
        s = re.sub(r"(open|closed|upcoming|listed|live|active|forthcoming)$", "", s)
        s = re.sub(r"(sme|ipo|limited|ltd|pvt|private|india)$", "", s)
        if s == before:
            break
    return s


# MUFG rotates its dropdown to recent issues only, but SearchOnPan keeps
# answering for older company IDs (verified live). So every company list we
# see is merged into an append-only memory — past IPOs stay checkable long
# after they fall off the dropdown.
_MUFG_IDS_PATH = Path(os.environ.get("AXEWATCH_DB", "/data/axewatch.db")).parent / "mufg_company_ids.json"
_MUFG_IDS_PRUNE_DAYS = 180


def _remember_mufg_ids(companies: list[dict]) -> None:
    try:
        mem: dict = {}
        if _MUFG_IDS_PATH.exists():
            mem = json.loads(_MUFG_IDS_PATH.read_text(encoding="utf-8"))
        now = time.time()
        for c in companies:
            key = canon_ipo_name(c.get("name"))
            if key and c.get("id"):
                mem[key] = {"id": str(c["id"]), "name": c["name"], "last_seen": now}
        cutoff = now - _MUFG_IDS_PRUNE_DAYS * 86400
        mem = {k: v for k, v in mem.items() if v.get("last_seen", 0) > cutoff}
        _MUFG_IDS_PATH.parent.mkdir(parents=True, exist_ok=True)
        _MUFG_IDS_PATH.write_text(json.dumps(mem), encoding="utf-8")
    except Exception as exc:
        logger.warning("mufg id memory save failed: %s", exc)


def remembered_mufg_ids() -> dict:
    try:
        if _MUFG_IDS_PATH.exists():
            return json.loads(_MUFG_IDS_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("mufg id memory load failed: %s", exc)
    return {}


_BIGSHARE_IDS_PATH = Path(os.environ.get("AXEWATCH_DB", "/data/axewatch.db")).parent / "bigshare_company_ids.json"
_BIGSHARE_IDS_PRUNE_DAYS = 180


def _remember_bigshare_ids(companies: list[dict]) -> None:
    try:
        mem: dict = {}
        if _BIGSHARE_IDS_PATH.exists():
            mem = json.loads(_BIGSHARE_IDS_PATH.read_text(encoding="utf-8"))
        now = time.time()
        for c in companies:
            key = canon_ipo_name(c.get("name"))
            if key and c.get("id"):
                mem[key] = {"id": str(c["id"]), "name": c["name"], "last_seen": now}
        cutoff = now - _BIGSHARE_IDS_PRUNE_DAYS * 86400
        mem = {k: v for k, v in mem.items() if v.get("last_seen", 0) > cutoff}
        _BIGSHARE_IDS_PATH.parent.mkdir(parents=True, exist_ok=True)
        _BIGSHARE_IDS_PATH.write_text(json.dumps(mem), encoding="utf-8")
    except Exception as exc:
        logger.warning("bigshare id memory save failed: %s", exc)


def remembered_bigshare_ids() -> dict:
    try:
        if _BIGSHARE_IDS_PATH.exists():
            return json.loads(_BIGSHARE_IDS_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("bigshare id memory load failed: %s", exc)
    return {}


# ---------------------------------------------------------------------------
# registrar directory: which RTA handles which issue
# ---------------------------------------------------------------------------
# Bigshare's captcha guards only the SEARCH — the company dropdowns are public
# on all three mirror servers, so we can attribute Bigshare-handled IPOs
# exactly instead of reporting a misleading "no record".

_REGDIR: tuple[float, dict] = (0.0, {})
_REGDIR_TTL = 24 * 3600


def directory_if_warm() -> dict | None:
    """Cached directory without triggering any network fetch (may be None)."""
    ts, cached = _REGDIR
    if cached and time.time() - ts < _REGDIR_TTL:
        return cached
    return None


_IPOMARKET_URL = "https://ipomarket.in/allotment"


def _ipomarket_registrar_key(text: str) -> str | None:
    t = (text or "").lower()
    if "mufg" in t or "link intime" in t or "linkintime" in t:
        return "mufg"
    if "kfin" in t:
        return "kfin"
    if "bigshare" in t or "big share" in t:
        return "bigshare"
    if "skyline" in t:
        return "skyline"
    if "cameo" in t:
        return "cameo"
    if "purva" in t:
        return "purva"
    if "maashitla" in t:
        return "maashitla"
    if "beetal" in t:
        return "beetal"
    return None


def _ipomarket_allotments() -> list[dict]:
    """[(name, allotment_date, registrar)] from ipomarket's allotment tables.

    This is the only public source that maps CURRENT issues to KFintech and
    the smaller SME registrars (their own pages expose no company list).
    Directory-grade data, not personal data; failures are tolerated.
    """
    r = requests.get(_IPOMARKET_URL, headers={"User-Agent": MUFG_UA}, timeout=30)
    r.raise_for_status()
    r.encoding = "utf-8"
    out = []
    for section in re.split(r"<h3[^>]*>", r.text)[1:]:
        m = re.search(r"<table[^>]*>(.*?)</table>", section, re.S | re.I)
        if not m:
            continue
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", m.group(1), re.S | re.I):
            cells = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", c))).strip()
                     for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S | re.I)]
            cells = [c for c in cells if c]
            if len(cells) >= 3 and "company" not in cells[0].lower():
                key = _ipomarket_registrar_key(cells[2])
                if key:
                    out.append({"name": cells[0], "allotment_date": cells[1], "registrar": key})
    return out


def _bigshare_companies(url: str) -> list[dict]:
    r = requests.get(url, headers={"User-Agent": MUFG_UA}, timeout=25)
    r.raise_for_status()
    r.encoding = "utf-8"
    # scope to the company dropdown only (other selects share the page)
    m = re.search(r'<select[^>]*id="ddlCompany"[^>]*>(.*?)</select>', r.text, re.S | re.I)
    block = m.group(1) if m else r.text
    out = []
    for value, label in re.findall(r'<option[^>]*value="([^"]*)"[^>]*>([^<]{2,100})</option>', block):
        value, label = value.strip(), label.strip()
        if value and value != "0" and label and "select" not in label.lower():
            out.append({"id": value, "name": label})
    return out


def registrar_directory(force: bool = False) -> dict:
    """canon_name -> {"registrar", "name", "allotment_date"?}.

    MUFG from their live company API and Bigshare from the public dropdowns
    are authoritative; ipomarket's allotment tables fill the rest (notably
    KFintech and the smaller SME registrars, which publish no company list)
    and backfill declared allotment dates. Cached 24h; individual source
    failures are tolerated (attribution just gets sparser, checks still run).
    """
    global _REGDIR
    ts, cached = _REGDIR
    if cached and not force and time.time() - ts < _REGDIR_TTL:
        return cached
    directory: dict[str, dict] = {}
    try:
        for c in mufg_companies():
            key = canon_ipo_name(c.get("name"))
            if key:
                directory[key] = {"registrar": "mufg", "name": c["name"], "id": str(c.get("id", ""))}
    except Exception as exc:
        logger.warning("registrar directory MUFG failed: %s", exc)
    for url in BIGSHARE_STATUS_URLS:
        try:
            _pace("allot_regdir", gap=1.0)
            t0 = time.time()
            found = _bigshare_companies(url)
            health.record("allot_regdir", ok=True, latency=time.time() - t0)
            _remember_bigshare_ids(found)
            for c in found:
                key = canon_ipo_name(c.get("name"))
                if key and key not in directory:
                    directory[key] = {"registrar": "bigshare", "name": c["name"], "id": str(c.get("id", ""))}
        except Exception as exc:
            health.record("allot_regdir", ok=False, latency=0.0, error=exc)
            logger.warning("registrar directory %s failed: %s", url, exc)
    try:
        _pace("allot_regdir", gap=1.0)
        t0 = time.time()
        for e in _ipomarket_allotments():
            key = canon_ipo_name(e["name"])
            if not key:
                continue
            if key not in directory:
                directory[key] = {"registrar": e["registrar"], "name": e["name"],
                                  "allotment_date": e["allotment_date"]}
            elif e["allotment_date"] and not directory[key].get("allotment_date"):
                directory[key]["allotment_date"] = e["allotment_date"]
        health.record("allot_regdir", ok=True, latency=time.time() - t0)
    except Exception as exc:
        health.record("allot_regdir", ok=False, latency=0.0, error=exc)
        logger.warning("registrar directory ipomarket failed: %s", exc)
    # Do not turn a temporary upstream outage into a 24-hour blind spot.  An
    # empty directory means neither live source could be read, so let the next
    # request try again; a partial directory is still useful and is cached.
    if directory:
        _REGDIR = (time.time(), directory)
    by_reg: dict[str, int] = {}
    for v in directory.values():
        by_reg[v["registrar"]] = by_reg.get(v["registrar"], 0) + 1
    logger.info("registrar directory: %d issues %s", len(directory), by_reg)
    return directory


def attribute_registrar(name: str | None, directory: dict | None = None) -> dict | None:
    """Best directory hit for an issue name (exact canon, then substring)."""
    want = canon_ipo_name(name)
    if not want:
        return None
    directory = directory if directory is not None else registrar_directory()
    if want in directory:
        return directory[want]
    for key, val in directory.items():
        if key and (key in want or want in key):
            return val
    return None


def valid_pan(pan: str) -> bool:
    return bool(PAN_RE.fullmatch((pan or "").strip().upper()))


def mask_pan(pan: str) -> str:
    p = (pan or "").strip().upper()
    return (p[:2] + "*****" + p[-1:]) if len(p) == 10 else "***"


def _num(v) -> int | None:
    try:
        return int(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        try:
            return int(float(str(v).replace(",", "").strip()))
        except (TypeError, ValueError):
            return None


class AllotmentError(Exception):
    """Fatal for this lookup (bad input, unexpected page shape)."""


class AllotmentTransient(Exception):
    """Transport trouble — cooldown/rate-limit; safe to retry later."""


_throttle_lock = threading.Lock()
_last_call: dict[str, float] = {}


def _pace(source: str, gap: float = 1.5) -> None:
    """Reserve a source call slot without allowing concurrent callers to burst.

    Bulk checks and a manual re-check can run in separate threads.  The old
    unlock/sleep/relock sequence let all of them observe the same available
    slot, then fire together after sleeping.  That intermittently triggered
    registrar throttles, especially at Bigshare.
    """
    with _throttle_lock:
        wait = _last_call.get(source, 0.0) + gap - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_call[source] = time.time()


def _retry_after(resp) -> float | None:
    v = resp.headers.get("Retry-After")
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# MUFG Intime
# ---------------------------------------------------------------------------

_MUFG_COMPANIES: tuple[float, list[dict]] = (0.0, [])
_MUFG_COMPANIES_TTL = 3600


def mufg_companies(force: bool = False) -> list[dict]:
    """Live company dropdown [{id, name}] — tells us which IPOs MUFG handles."""
    global _MUFG_COMPANIES
    ts, cached = _MUFG_COMPANIES
    if cached and not force and time.time() - ts < _MUFG_COMPANIES_TTL:
        return cached
    _pace("allot_mufg")
    t0 = time.time()
    try:
        s = requests.Session()
        s.headers.update({"User-Agent": MUFG_UA, "Referer": MUFG_BASE + "public-issues.html"})
        s.get(MUFG_BASE + "public-issues.html", timeout=20)
        r = s.post(
            MUFG_BASE + "IPO.aspx/GetDetails",
            json={},
            headers={"Content-Type": "application/json; charset=utf-8"},
            timeout=20,
        )
        health.record_response("allot_mufg", r.status_code, time.time() - t0, _retry_after(r))
        if r.status_code != 200:
            raise AllotmentTransient(f"MUFG company list HTTP {r.status_code}")
        root = ET.fromstring(r.json().get("d", "<NewDataSet />"))
        out = [
            {"id": (t.findtext("company_id") or "").strip(), "name": (t.findtext("companyname") or "").strip()}
            for t in root.findall("Table")
        ]
        out = [c for c in out if c["id"] and c["name"]]
        _MUFG_COMPANIES = (time.time(), out)
        _remember_mufg_ids(out)
        return out
    except AllotmentTransient:
        raise
    except Exception as exc:
        health.record("allot_mufg", ok=False, latency=time.time() - t0, error=exc)
        raise AllotmentTransient(f"MUFG company list failed: {exc}") from exc


def _mufg_token(session: requests.Session) -> str:
    """Server token, AES-encrypted exactly like MUFG's own page does."""
    r = session.post(MUFG_BASE + "IPO.aspx/generateToken", json={}, timeout=20)
    if r.status_code in (429, 503):
        raise AllotmentTransient(f"MUFG token HTTP {r.status_code}")
    if r.status_code != 200:
        raise AllotmentTransient(f"MUFG token HTTP {r.status_code}")
    token = (r.json().get("d") or "").strip()
    if not token:
        raise AllotmentTransient("MUFG token empty")
    cipher = AES.new(_MUFG_AES_KEY, AES.MODE_CBC, _MUFG_AES_KEY)
    return base64.b64encode(cipher.encrypt(pad(token.encode(), 16))).decode()


def mufg_session() -> requests.Session:
    """One warmed session per PAN-run: landing page once, then token+search
    per company. Fewer requests than a fresh session per lookup, and warm
    cookies fail less often than cold ones."""
    s = requests.Session()
    s.headers.update({"User-Agent": MUFG_UA, "Referer": MUFG_BASE + "public-issues.html"})
    s.get(MUFG_BASE + "public-issues.html", timeout=20)
    return s


def _is_throttle_message(msg: str) -> bool:
    m = msg.lower()
    return "429" in m or "503" in m or "throttled" in m or "cooling down" in m


def mufg_check(pan: str, company_id: str, company_name: str = "",
               session: requests.Session | None = None) -> dict:
    """PAN allotment at MUFG for one company. found=False == no record.

    Retries ONCE on transport blips (connection reset, timeout, 5xx) — never
    on throttle responses (429/503), which surface immediately so the health
    breaker can cool the source down. Same request budget either way.
    """
    pan = pan.strip().upper()
    _pace("allot_mufg")
    t0 = time.time()
    own_session = session is None
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            s = session if session is not None else requests.Session()
            if own_session:
                s.headers.update({"User-Agent": MUFG_UA, "Referer": MUFG_BASE + "public-issues.html"})
                s.get(MUFG_BASE + "public-issues.html", timeout=20)
            token = _mufg_token(s)
            r = s.post(
                MUFG_BASE + "IPO.aspx/SearchOnPan",
                json={"clientid": company_id, "PAN": pan, "IFSC": "", "CHKVAL": "1", "token": token},
                headers={"Content-Type": "application/json; charset=utf-8"},
                timeout=30,
            )
            health.record_response("allot_mufg", r.status_code, time.time() - t0, _retry_after(r))
            if r.status_code in (429, 503):
                raise AllotmentTransient(f"MUFG throttled (HTTP {r.status_code})")
            if r.status_code != 200:
                raise AllotmentTransient(f"MUFG search HTTP {r.status_code}")
            root = ET.fromstring(r.json().get("d", "<NewDataSet />"))
            for t in root.findall("Table1"):
                msg = (t.findtext("Msg") or "").strip()
                if msg:
                    health.record("allot_mufg", ok=True, latency=time.time() - t0, neutral=True)
                    return {"source": "mufg", "found": False, "note": msg or "no record"}
            records = []
            for t in root.findall("Table"):
                applied = _num(t.findtext("SHARES"))
                allotted = _num(t.findtext("ALLOT"))
                records.append(
                    {
                        "appln_no": (t.findtext("PEMNDG") or "").strip() or None,
                        "name": (t.findtext("NAME1") or "").strip() or None,
                        "applied": applied,
                        "allotted": allotted,
                        "price": (t.findtext("offer_price") or "").strip() or None,
                        "amount_adj": (t.findtext("AMTADJ") or "").strip() or None,
                        "refund": (t.findtext("RFNDAMT") or "").strip() or None,
                    }
                )
            health.record("allot_mufg", ok=True, latency=time.time() - t0, neutral=not records)
            if not records:
                return {"source": "mufg", "found": False, "note": "no record"}
            return {"source": "mufg", "found": True, "company": company_name, "records": records}
        except AllotmentTransient as exc:
            # throttle responses must NOT be retried — respect their backoff
            if _is_throttle_message(str(exc)) or attempt == 1:
                raise
            last_exc = exc
            time.sleep(2)
        except Exception as exc:
            if attempt == 1:
                health.record("allot_mufg", ok=False, latency=time.time() - t0, error=exc)
                raise AllotmentTransient(f"MUFG search failed: {exc}") from exc
            last_exc = exc
            time.sleep(2)
    health.record("allot_mufg", ok=False, latency=time.time() - t0, error=last_exc)
    raise AllotmentTransient(f"MUFG search failed after retry: {last_exc}") from last_exc


# ---------------------------------------------------------------------------
# KFintech
# ---------------------------------------------------------------------------

def kfin_check(pan: str) -> dict:
    """PAN allotment across KFintech-handled IPOs in one call.

    HTTP 200 -> records (each with All_Shares/App_Shares/Appln_No/Name).
    HTTP 400 -> no record for this PAN. Anything else -> transient.
    """
    pan = pan.strip().upper()
    _pace("allot_kfin", gap=2.0)
    t0 = time.time()
    try:
        # One retry on gateway wobbles (their own page retries 429/5xx too).
        # A 429 is honored once (capped wait) instead of hammered; anything
        # persistent becomes a transient error for the caller.
        r = None
        for attempt in range(2):
            r = requests.get(
                KFIN_URL,
                params={"type": "pan"},
                headers={
                    "User-Agent": MUFG_UA,
                    "Accept": "application/json, text/plain, */*",
                    "Referer": "https://ipostatus.kfintech.com/",
                    "Origin": "https://ipostatus.kfintech.com",
                    "reqparam": pan,
                    # matches their own page, which sends an empty client_id
                    # (search-all). Verified: requests preserves the empty value
                    # on the wire and the API answers identically to a browser.
                    "client_id": "",
                },
                timeout=25,
            )
            if r.status_code == 429 and attempt == 0:
                wait = _retry_after(r)
                time.sleep(min(wait, 15.0) if wait else 5.0)
                continue
            if r.status_code not in (502, 503, 504) or attempt == 1:
                break
            time.sleep(3)
        if r.status_code == 400:
            health.record("allot_kfin", ok=True, latency=time.time() - t0, neutral=True)
            return {"source": "kfin", "found": False, "note": "no record"}
        health.record_response("allot_kfin", r.status_code, time.time() - t0, _retry_after(r))
        if r.status_code in (429, 500, 502, 504):
            raise AllotmentTransient(f"KFintech HTTP {r.status_code}")
        if r.status_code != 200:
            raise AllotmentTransient(f"KFintech HTTP {r.status_code}")
        payload = r.json()
        items = payload if isinstance(payload, list) else payload.get("data", payload.get("records", []))
        records = []
        for it in items if isinstance(items, list) else []:
            if not isinstance(it, dict):
                continue
            allotted = _num(it.get("All_Shares", it.get("all_shares")))
            applied = _num(it.get("App_Shares", it.get("app_shares")))
            if allotted is None and applied is None:
                continue
            records.append(
                {
                    "company": str(it.get("Company", it.get("company", ""))).strip() or None,
                    "appln_no": str(it.get("Appln_No", it.get("appln_no", ""))).strip() or None,
                    "name": str(it.get("Name", it.get("name", ""))).strip() or None,
                    "applied": applied,
                    "allotted": allotted,
                    "pan_tail": str(it.get("Pan_no", it.get("pan_no", ""))).strip()[-4:] or None,
                }
            )
        health.record("allot_kfin", ok=True, latency=time.time() - t0, neutral=not records)
        if not records:
            return {"source": "kfin", "found": False, "note": "no record"}
        return {"source": "kfin", "found": True, "records": records}
    except (AllotmentTransient, AllotmentError):
        raise
    except Exception as exc:
        health.record("allot_kfin", ok=False, latency=time.time() - t0, error=exc)
        raise AllotmentTransient(f"KFintech check failed: {exc}") from exc


# ---------------------------------------------------------------------------
# Bigshare Services
# ---------------------------------------------------------------------------
# Bigshare guards its result search with a server-verified CAPTCHA (confirmed
# live with a dummy-token probe: the server answers Status=CAPTCHA). There is
# no legitimate automated path here: OCR-solving it would defeat an explicitly
# documented anti-abuse control on someone else's rate-limited server, feed
# users unreliable guesses on financial data, and get this IP throttled (their
# backoff asks for up to ~15 minutes). So Bigshare stays manual-only: the
# registrar directory reads its PUBLIC company lists, and the UI hands the
# user a deep link naming the exact dropdown entry to pick.


def bigshare_check(pan: str, company_id: str, company_name: str = "") -> dict:
    """Never automated - Bigshare lookups need a user-completed CAPTCHA."""
    raise AllotmentTransient("Bigshare requires manual CAPTCHA verification on its official site")
