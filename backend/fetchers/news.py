"""Per-stock news via Google News RSS.

Deliberately NOT served from NSE: their Akamai budget is tight (see AGENTS.md
rate rules)
and Google News needs no cookies, has no rate limits to worry about, and returns
UTF-8 RSS we can parse deterministically.
"""

import html
import logging
from xml.etree import ElementTree

import requests

from fetchers import health

logger = logging.getLogger("axewatch.news")

_RSS_URL = "https://news.google.com/rss/search"
_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
    ),
    "accept": "*/*",
}


def stock_news(symbol: str, limit: int = 12) -> dict:
    """Return recent news items for an NSE stock symbol."""
    import time as _time

    sym = symbol.strip().upper()
    t0 = _time.time()
    try:
        r = requests.get(
            _RSS_URL,
            params={"q": f"{sym} NSE stock", "hl": "en-IN", "gl": "IN", "ceid": "IN:en"},
            headers=_HEADERS,
            timeout=15,
        )
        r.raise_for_status()
        r.encoding = "utf-8"  # titles carry ₹ / quotes; requests guesses wrong otherwise
    except Exception as exc:
        health.record("google_news", ok=False, latency=_time.time() - t0, error=exc)
        raise
    root = ElementTree.fromstring(r.content)

    items: list[dict] = []
    for it in root.iter("item"):
        title = html.unescape((it.findtext("title") or "").strip())
        source_el = it.find("source")
        source = (source_el.text or "").strip() if source_el is not None else None
        # Google appends " - <Publisher>" to titles; drop it since we show source separately
        if source and title.endswith(f" - {source}"):
            title = title[: -len(f" - {source}")].rstrip()
        if not title:
            continue
        items.append(
            {
                "title": title,
                "link": (it.findtext("link") or "").strip(),
                "published": (it.findtext("pubDate") or "").strip(),
                "source": source,
            }
        )
        if len(items) >= limit:
            break
    health.record("google_news", ok=True, latency=_time.time() - t0, status=200)
    return {"symbol": sym, "items": items}
