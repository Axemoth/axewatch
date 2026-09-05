import logging
import json
import re
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

from fetchers import health

logger = logging.getLogger("axewatch.gmp")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
)

STATUS_KEYWORDS = ["OPEN", "UPCOMING", "CLOSED", "LISTED", "ALLOTED", "ALLOTTED"]
STATUS_PRIORITY = {
    "open": 0,
    "upcoming": 1,
    "alloted": 2,
    "allotted": 2,
    "closed": 3,
    "listed": 4,
}


def _extract_status(name: str | None, status_field: str | None) -> tuple[str | None, str | None]:
    field = (status_field or "").strip()
    fl = field.lower()
    if fl in STATUS_PRIORITY:
        return name, field.title() if fl == "allotted" else field.capitalize()
    if not name:
        return name, None
    cleaned = name.strip()
    upper = cleaned.upper()
    for kw in STATUS_KEYWORDS:
        if upper.endswith(kw):
            base = cleaned[: len(cleaned) - len(kw)].strip()
            canon = kw.lower()
            canon = "Allotted" if canon.startswith("allo") else canon.capitalize()
            return base, canon
    return cleaned, None


def _status_priority(status: str | None) -> int:
    if not status:
        return 9
    return STATUS_PRIORITY.get(status.lower(), 9)


def _gmp_value(row: dict) -> float:
    raw = row.get("gmp") or ""
    m = re.search(r"-?\d+(?:\.\d+)?", str(raw))
    return float(m.group()) if m else 0.0


def _finalize_rows(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        name, status = _extract_status(row.get("name"), row.get("status"))
        row["name"] = name
        row["status"] = status
        row["priority"] = _status_priority(status)
        out.append(row)
    return out

COLUMN_ALIASES = {
    "name": ["ipo", "ipo name", "company", "company name"],
    "gmp": ["gmp", "ipo gmp", "gmp (rs)", "gmp â‚¹", "premium"],
    "gmp_percent": ["gmp %", "gmp%", "%"],
    "trend": ["trend"],
    "price": ["price band", "price", "ipo price", "issue price"],
    "est_listing": ["est. listing", "estimated listing", "listing gain", "exp listing"],
    "listing_price": ["listing price", "listing"],
    "dates": ["date", "open date", "bidding", "open-close", "open - close", "ipo date"],
    "sub_x": ["subscription", "sub", "overall"],
    "type": ["type"],
    "status": ["status"],
    "updated": ["last updated", "updated"],
    "lot_size": ["lot size"],
    "issue_size": ["issue size"],
    "boa": ["boa"],
}


def _match_header(header: str) -> str | None:
    h = re.sub(r"[^a-z0-9%]+", " ", header.strip().lower()).strip()
    h_compact = h.replace(" ", "")
    for canonical, aliases in COLUMN_ALIASES.items():
        for a in aliases:
            a_norm = re.sub(r"[^a-z0-9%]+", " ", a.lower()).strip()
            a_compact = a_norm.replace(" ", "")
            if h == a_norm or h_compact == a_compact or (len(a_norm) > 3 and a_norm in h):
                return canonical
    return None


def _clean(text: str | None) -> str | None:
    if text is None:
        return None
    t = re.sub(r"\s+", " ", text).strip()
    return t or None


def _parse_table(table) -> list[dict]:
    rows = table.find_all("tr")
    header_idx = None
    header_cells = []
    for i, tr in enumerate(rows):
        cells = tr.find_all(["th", "td"])
        if len(cells) >= 4:
            texts = [_clean(c.get_text()) or "" for c in cells]
            if _match_header(texts[0]) and any(_match_header(t) for t in texts[1:]):
                header_idx = i
                header_cells = texts
                break
    if header_idx is None:
        return []
    colmap = {}
    for i, h in enumerate(header_cells):
        canon = _match_header(h)
        if canon and canon not in colmap:
            colmap[canon] = i
    if "name" not in colmap:
        return []

    parsed = []
    for tr in rows[header_idx + 1 :]:
        cells = tr.find_all("td")
        if len(cells) < len(header_cells) - 2:
            continue
        record = {"source": None}
        for canon, idx in colmap.items():
            if idx < len(cells):
                record[canon] = _clean(cells[idx].get_text())
        name = record.get("name")
        if name and not re.match(r"^(ipo|company)", name.strip().lower()):
            parsed.append(record)
    return _finalize_rows(parsed)


def _find_gmp_tables(html: str):
    soup = BeautifulSoup(html, "lxml")
    candidates = []
    for table in soup.find_all("table"):
        rows = _parse_table(table)
        if rows:
            with_status = sum(1 for r in rows if r.get("status"))
            candidates.append((with_status, len(rows), rows))
    if not candidates:
        return []
    candidates.sort(key=lambda c: (c[0] > 0, c[0], c[1]), reverse=True)
    return candidates[0][2]


GMP_SOURCE_KEYS = {
    "fetch_ipowatch": "gmp_ipowatch",
    "fetch_ipoindex": "gmp_ipoindex",
    "fetch_investorgain": "gmp_investorgain",
}


def _tracked_gmp(fn):
    return health.tracked(GMP_SOURCE_KEYS[fn.__name__])(fn)


@_tracked_gmp
def fetch_ipowatch() -> list[dict]:
    url = "https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/"
    r = requests.get(url, headers={"user-agent": UA}, timeout=25)
    r.raise_for_status()
    r.encoding = "utf-8"
    rows = _find_gmp_tables(r.text)
    for row in rows:
        row["source"] = "ipowatch"
    return rows


@_tracked_gmp
def fetch_ipoindex() -> list[dict]:
    url = "https://ipoindex.in/"
    r = requests.get(url, headers={"user-agent": UA}, timeout=25)
    r.raise_for_status()
    r.encoding = "utf-8"
    rows = _find_gmp_tables(r.text)
    for row in rows:
        row["source"] = "ipoindex"
    return rows


@_tracked_gmp
def fetch_investorgain() -> list[dict]:
    url = "https://www.investorgain.com/report/live-ipo-gmp/331/"
    r = requests.get(url, headers={"user-agent": UA}, timeout=25)
    r.raise_for_status()
    r.encoding = "utf-8"
    html = r.text
    matches = re.findall(
        r'"(?:reportTableData|data)"\s*:\s*(\[\{.*?\}\])', html, re.DOTALL
    )
    rows = []
    for m in matches[:1]:
        try:
            try:
                raw = json.loads(m)
            except json.JSONDecodeError:
                raw = json.loads(m.encode("utf-8", "ignore").decode("unicode_escape"))
            for item in raw:
                rows.append(
                    {
                        "name": _clean(item.get("~ipo_name") or item.get("name")),
                        "gmp": _clean(str(item.get("~gmp") or item.get("gmp") or "")),
                        "gmp_percent": _clean(
                            str(item.get("~gmp_percent_calc") or item.get("gmp_percent") or "")
                        ),
                        "price": _clean(str(item.get("Price") or "")),
                        "dates": _clean(f"{item.get('Open', '')} - {item.get('Close', '')}"),
                        "status": None,
                        "source": "investorgain",
                    }
                )
        except Exception as exc:
            logger.warning("investorgain json parse failed: %s", exc)
    if not rows:
        rows = _find_gmp_tables(html)
        for row in rows:
            row["source"] = "investorgain"
    return rows


SOURCES = [fetch_ipowatch, fetch_ipoindex, fetch_investorgain]


def _norm_name(s: str) -> str:
    s = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    s = re.sub(r"\b(ltd|limited|india|the)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


@health.tracked("ipowatch_past")
def fetch_past_performance() -> list[dict]:
    url = "https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/"
    r = requests.get(url, headers={"user-agent": UA}, timeout=25)
    r.raise_for_status()
    r.encoding = "utf-8"
    soup = BeautifulSoup(r.text, "lxml")
    out = []
    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        if not rows:
            continue
        header = [re.sub(r"\s+", " ", c.get_text(strip=True)).lower() for c in rows[0].find_all(["th", "td"])]
        def find(*aliases: str) -> int:
            for i, h in enumerate(header):
                if any(a in h for a in aliases):
                    return i
            return -1
        i_name, i_price, i_gmp, i_listing = (
            find("ipo name", "company"),
            find("ipo price", "issue price", "price band"),
            find("gmp"),
            find("listing price", "listing "),
        )
        if i_name < 0 or i_listing < 0 or i_gmp < 0:
            continue
        for tr in rows[1:]:
            cells = [c for c in tr.find_all("td")]
            if len(cells) <= max(i_name, i_gmp, i_listing):
                continue
            name = _clean(tr.find_all(["th", "td"])[i_name].get_text()) if i_name < len(tr.find_all(["th", "td"])) else None
            name = _clean(cells[i_name].get_text()) if i_name < len(cells) else None
            if not name or re.match(r"^(ipo|company)", name.strip().lower()):
                continue
            out.append(
                {
                    "name": name,
                    "norm": _norm_name(name),
                    "issue_price": _clean(cells[i_price].get_text()) if 0 <= i_price < len(cells) else None,
                    "gmp": _clean(cells[i_gmp].get_text()) if i_gmp < len(cells) else None,
                    "listing_price": _clean(cells[i_listing].get_text()),
                }
            )
    seen = set()
    deduped = []
    for row in out:
        if row["norm"] and row["norm"] not in seen:
            seen.add(row["norm"])
            deduped.append(row)
    return deduped


def get_gmp_with_failover() -> dict:
    errors = []
    # circuit breaker: try healthy sources first (keeping the usual order among
    # them); if every source is in cooldown, ignore cooldowns — a slow retry
    # beats returning nothing.
    healthy = [f for f in SOURCES if health.is_available(GMP_SOURCE_KEYS[f.__name__])]
    order = healthy or list(SOURCES)
    for fetch in order:
        try:
            rows = fetch()
            if rows:
                rows = _finalize_rows(rows)
                rows.sort(key=lambda r: (r.get("priority", 9), -_gmp_value(r)))
                return {
                    "rows": rows,
                    "source_used": rows[0].get("source"),
                    "count": len(rows),
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                }
        except Exception as exc:
            logger.warning("GMP source %s failed: %s", fetch.__name__, exc)
            errors.append(f"{fetch.__name__}: {exc}")
    raise RuntimeError(f"all GMP sources failed: {errors}")

