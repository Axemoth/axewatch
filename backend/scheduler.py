import logging
import threading
import time

from apscheduler.schedulers.background import BackgroundScheduler

import db
from fetchers import nse, ipo, gmp

logger = logging.getLogger("axewatch.scheduler")

MARKET_KINDS = {
    "market_status": nse.market_status,
    "all_indices": nse.all_indices,
    "gainers": lambda: nse.gainers_losers("gainers"),
    "losers": lambda: nse.gainers_losers("loosers"),
    "ipo_current": lambda: {"ipos": ipo.current_ipos()},
    "ipo_upcoming": lambda: {"ipos": ipo.upcoming_ipos()},
}

SECTORAL_INDICES = {
    "NIFTY IT", "NIFTY BANK", "NIFTY AUTO", "NIFTY FMCG", "NIFTY PHARMA",
    "NIFTY METAL", "NIFTY REALTY", "NIFTY ENERGY", "NIFTY MEDIA",
    "NIFTY PSU BANK", "NIFTY PRIVATE BANK", "NIFTY FINANCIAL SERVICES",
    "NIFTY FIN SERVICE", "NIFTY CONSUMER DURABLES", "NIFTY OIL & GAS",
    "NIFTY HEALTHCARE", "NIFTY COMMODITIES", "NIFTY CONSTRUCTION",
    "NIFTY INFRASTRUCTURE", "NIFTY MNC", "NIFTY PSE", "NIFTY SERVICES SECTOR",
    "NIFTY CHEMICALS",
}


def refresh_market() -> None:
    for kind, fn in MARKET_KINDS.items():
        try:
            db.save_snapshot(kind, fn())
            logger.info("refreshed %s", kind)
        except Exception as exc:
            logger.warning("refresh %s failed: %s", kind, exc)
    try:
        check_limit_orders()
    except Exception as exc:
        logger.warning("limit order check failed: %s", exc)


def refresh_gmp() -> None:
    try:
        result = gmp.get_gmp_with_failover()
        db.save_snapshot("gmp", result)
        logger.info("refreshed gmp via %s (%d rows)", result["source_used"], result["count"])
    except Exception as exc:
        logger.warning("gmp refresh failed: %s", exc)
    try:
        past = gmp.fetch_past_performance()
        db.save_snapshot("ipo_past_perf", {"rows": past})
        logger.info("refreshed ipo_past_perf (%d rows)", len(past))
    except Exception as exc:
        logger.warning("ipo_past_perf refresh failed: %s", exc)


def fetch_fiidii() -> None:
    try:
        data = nse.get_nse().get_json("/api/fiidiiTradeNse")
        db.save_snapshot("fiidii", {"rows": data, "fetched_at": time.time()})
        logger.info("refreshed fiidii (%d rows)", len(data) if isinstance(data, list) else 0)
    except Exception as exc:
        logger.warning("fiidii fetch failed: %s", exc)


def resolve_signals() -> None:
    """Walk each open signal's forward window on real Yahoo bars: whichever of
    stop / target_1 was touched first decides the outcome; expiry at horizon
    closes at the horizon close. One Yahoo call per open signal, staggered."""
    from fetchers import yahoo
    from fetchers import health

    pending = db.open_signals()
    if not pending:
        return
    if not health.is_available("yahoo"):
        logger.info("signal resolution skipped: yahoo cooling down")
        return
    for sig in pending:
        age_days = (time.time() - sig["planned_at"]) / 86400
        if age_days < sig["horizon_days"]:
            continue
        try:
            time.sleep(0.5)
            hist = yahoo.history(sig["symbol"], "3mo")
            if not hist:
                continue
            bars = [
                b
                for b in hist["rows"]
                if b["t"] >= sig["planned_at"] - 86400
            ]
            if not bars:
                db.resolve_signal(sig["id"], "no_data", sig["entry"], None)
                continue
            entry, stop, t1 = sig["entry"], sig["stop"], sig["target_1"]
            outcome, exit_price = None, None
            for b in bars:
                if sig["signal"] == "BUY":
                    hit_stop = stop is not None and b["l"] <= stop
                    hit_target = t1 is not None and b["h"] >= t1
                else:
                    hit_stop = stop is not None and b["h"] >= stop
                    hit_target = t1 is not None and b["l"] <= t1
                if hit_stop and hit_target:
                    outcome = "hit_stop"  # same bar: assume stop first (conservative)
                    exit_price = stop
                    break
                if hit_stop:
                    outcome, exit_price = "hit_stop", stop
                    break
                if hit_target:
                    outcome, exit_price = "hit_target_1", t1
                    break
            if outcome is None:
                outcome = "expired"
                exit_price = bars[-1]["c"]
            risk = None
            if stop is not None and entry:
                risk = abs(entry - stop)
            r_mult = None
            if outcome in ("hit_target_1", "hit_stop", "expired") and risk:
                move = exit_price - entry if sig["signal"] == "BUY" else entry - exit_price
                r_mult = move / risk
            db.resolve_signal(sig["id"], outcome, exit_price, r_mult)
            logger.info("signal %s %s resolved: %s @ %s", sig["symbol"], sig["signal"], outcome, exit_price)
        except Exception as exc:
            logger.warning("signal resolve %s failed: %s", sig["symbol"], exc)


def check_limit_orders() -> None:
    """Fill pending paper limit orders when the live price crosses the limit.
    Runs inside the 2-min market refresh — no extra NSE calls, only the
    staggered Yahoo chain per open order."""
    from main import _execute_paper_fill, _stock_price_map

    orders = db.open_limit_orders()
    if not orders:
        return
    prices = _stock_price_map(list({o["symbol"] for o in orders}))
    for o in orders:
        px = (prices.get(o["symbol"]) or {}).get("last_price")
        if not px:
            continue
        should = px <= o["limit_price"] if o["side"] == "BUY" else px >= o["limit_price"]
        if not should:
            continue
        try:
            _execute_paper_fill(o["side"], o["symbol"], o["quantity"], float(px), o["name"])
            db.fill_limit_order(o["id"], px)
            logger.info("limit %s %s filled @ %s", o["side"], o["symbol"], px)
        except Exception as exc:
            db.cancel_limit_order(o["id"])
            logger.warning("limit %s %s cancelled: %s", o["side"], o["symbol"], exc)


def daily_signal_scan() -> None:
    """Compute outlooks for every NIFTY 50 constituent once a day so the
    signal tracker builds a track record without anyone browsing. Each outlook
    logs its BUY/SELL to signal_log; HOLD is skipped by design. Yahoo budget:
    ~50 staggered 5y fetches once per day, plus the cached NIFTY map."""
    import predict
    from fetchers import health

    snap = db.latest_snapshot("signal_scan")
    if snap and time.time() - snap["fetched_at"] < 20 * 3600:
        return
    if not health.is_available("yahoo"):
        logger.info("signal scan skipped: yahoo cooling down")
        return
    try:
        rows = nse.index_stocks("NIFTY 50")
        symbols = [
            str(r.get("symbol", "")).strip().upper()
            for r in (rows or {}).get("data") or []
        ]
        symbols = [s for s in dict.fromkeys(symbols) if s and s != "NIFTY 50"]
    except Exception as exc:
        logger.warning("signal scan: could not list constituents: %s", exc)
        return
    if len(symbols) < 10:
        logger.warning("signal scan: only %d symbols, aborting", len(symbols))
        return

    logger.info("daily signal scan starting (%d symbols)", len(symbols))
    ok = 0
    for k, sym in enumerate(symbols):
        if not health.is_available("yahoo"):
            logger.warning("signal scan aborted at %d/%d: yahoo cooling", k, len(symbols))
            break
        try:
            time.sleep(0.5)
            out = predict.outlook(sym)
            if out:
                ok += 1
        except Exception as exc:
            logger.warning("signal scan %s failed: %s", sym, exc)
    db.save_snapshot("signal_scan", {"scanned": len(symbols), "ok": ok, "fetched_at": time.time()})
    logger.info("daily signal scan done: %d/%d outlooks computed", ok, len(symbols))


def start_scheduler() -> BackgroundScheduler:
    sched = BackgroundScheduler(timezone="Asia/Kolkata")
    sched.add_job(refresh_market, "interval", minutes=2, id="market", max_instances=1)
    sched.add_job(refresh_gmp, "interval", minutes=30, id="gmp", max_instances=1)
    sched.add_job(resolve_signals, "interval", hours=1, id="signals", max_instances=1)
    sched.add_job(fetch_fiidii, "interval", hours=6, id="fiidii", max_instances=1)
    sched.add_job(
        daily_signal_scan, "cron", hour=17, minute=45, id="signal_scan",
        max_instances=1, misfire_grace_time=3600,
    )
    threading.Thread(target=fetch_fiidii, daemon=True).start()
    threading.Thread(target=resolve_signals, daemon=True).start()
    threading.Thread(target=daily_signal_scan, daemon=True).start()
    sched.start()
    logger.info("scheduler started")
    return sched
