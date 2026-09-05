import logging
import re

from .nse import get_nse

logger = logging.getLogger("axewatch.ipo")


def _num(value):
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _normalize_ipo(raw: dict) -> dict:
    return {
        "symbol": raw.get("symbol"),
        "name": raw.get("companyName"),
        "series": raw.get("series"),
        "status": raw.get("status"),
        "open_date": raw.get("issueStartDate"),
        "close_date": raw.get("issueEndDate"),
        "price_band": raw.get("issuePrice"),
        "issue_size_shares": _num(raw.get("issueSize")),
        "total_x": _num(raw.get("noOfTime")),
        "bids_received": raw.get("noOfsharesBid"),
    }


def _category_key(category: str) -> str | None:
    c = re.sub(r"\s+", " ", category.strip().lower())
    if c.startswith("qualified institutional"):
        return "qib"
    if re.match(r"^non institutional investors\s*\(\s*bid amount of more than ten lakh", c):
        return "bhni"
    if re.match(r"^non institutional investors\s*\(\s*bid.*two lakh.*ten lakh", c):
        return "shni"
    if c.startswith("non institutional"):
        return "nii"
    if c.startswith("retail individual"):
        return "rii"
    if c.startswith("employees"):
        return "employees"
    if c == "total":
        return "total"
    return None


def current_ipos() -> list[dict]:
    rows = get_nse().get_json("/api/ipo-current-issue")
    if isinstance(rows, dict):
        rows = rows.get("data", [])
    seen = {}
    for r in rows:
        norm = _normalize_ipo(r)
        sym = norm["symbol"]
        if sym not in seen:
            seen[sym] = norm
        else:
            existing_total = seen[sym].get("total_x")
            if norm.get("total_x") is not None and (
                existing_total is None or norm["total_x"] > existing_total
            ):
                seen[sym]["total_x"] = norm["total_x"]
    return list(seen.values())


def upcoming_ipos() -> list[dict]:
    rows = get_nse().get_json("/api/all-upcoming-issues", {"category": "ipo"})
    if isinstance(rows, dict):
        rows = rows.get("data", [])
    out, seen = [], set()
    for r in rows:
        norm = _normalize_ipo(r)
        sym = norm["symbol"]
        if sym in seen:
            continue
        if norm.get("status") and (
            "forthcom" in norm["status"].lower() or "upcom" in norm["status"].lower()
        ):
            seen.add(sym)
            out.append(norm)
    return out


def ipo_subscription(symbol: str) -> dict:
    series_hint = "SME" if symbol.upper().endswith("SME") else "EQ"
    data = get_nse().get_json(
        "/api/ipo-detail", {"symbol": symbol.upper(), "series": series_hint}
    )
    bids = data.get("bidDetails") or []
    breakdown = {}
    for b in bids:
        key = _category_key(b.get("category", ""))
        if key and key not in breakdown:
            breakdown[key] = {
                "x": _num(b.get("noOfTime")),
                "offered": _num(b.get("noOfSharesOffered")),
                "bid": b.get("noOfsharesBid"),
            }
    total = next(
        (b for b in bids if _category_key(b.get("category", "")) == "total"), None
    )
    if total is None:
        main_keys = ("qib", "nii", "rii")
        xs = [breakdown.get(k, {}).get("x") for k in main_keys]
        total_x = None if any(v is None for v in xs) else round(sum(xs), 2)
    else:
        total_x = _num(total.get("noOfTime"))
    return {
        "symbol": symbol.upper(),
        "total_x": total_x,
        **{k: v.get("x") for k, v in breakdown.items()},
        "breakdown": breakdown,
    }
