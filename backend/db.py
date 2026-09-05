import os
import sqlite3
import json
import time
from pathlib import Path

DB_PATH = Path(os.environ.get("AXEWATCH_DB", Path(__file__).parent / "axewatch.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kind_time ON snapshots(kind, fetched_at DESC);

CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_type TEXT NOT NULL CHECK (asset_type IN ('stock', 'mf')),
    symbol TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL CHECK (quantity > 0),
    avg_price REAL NOT NULL CHECK (avg_price >= 0),
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    UNIQUE (asset_type, symbol)
);

CREATE TABLE IF NOT EXISTS paper_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cash REAL NOT NULL,
    starting_cash REAL NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_positions (
    symbol TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL CHECK (quantity > 0),
    avg_price REAL NOT NULL CHECK (avg_price > 0),
    realized_pnl REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    symbol TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0),
    price REAL NOT NULL CHECK (price > 0),
    value REAL NOT NULL,
    realized_pnl REAL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_orders_ts ON paper_orders(ts DESC);

CREATE TABLE IF NOT EXISTS signal_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    signal TEXT NOT NULL CHECK (signal IN ('BUY', 'SELL')),
    score REAL NOT NULL,
    entry REAL NOT NULL,
    stop REAL,
    target_1 REAL,
    target_2 REAL,
    horizon_days INTEGER NOT NULL DEFAULT 10,
    planned_at REAL NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    outcome TEXT,
    exit_price REAL,
    r_multiple REAL,
    resolved_at REAL
);
CREATE INDEX IF NOT EXISTS idx_signal_symbol ON signal_log(symbol, planned_at DESC);

CREATE TABLE IF NOT EXISTS dividends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    amount_total REAL NOT NULL CHECK (amount_total > 0),
    ex_date TEXT,
    note TEXT,
    ts REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_limit_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    symbol TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL CHECK (quantity > 0),
    limit_price REAL NOT NULL CHECK (limit_price > 0),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FILLED', 'CANCELLED')),
    created_at REAL NOT NULL,
    filled_at REAL,
    filled_price REAL,
    note TEXT
);

CREATE TABLE IF NOT EXISTS paper_equity_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equity REAL NOT NULL,
    cash REAL NOT NULL,
    positions_value REAL NOT NULL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_equity_ts ON paper_equity_history(ts ASC);

-- IPO allotment: user-owned PANs (sensitive PII — always masked outside this module)
CREATE TABLE IF NOT EXISTS pan_vault (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL DEFAULT '',
    pan TEXT NOT NULL UNIQUE,
    created_at REAL NOT NULL
);

-- cached allotment outcomes per PAN x issue (allotment is final once declared)
CREATE TABLE IF NOT EXISTS allotment_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pan_id INTEGER NOT NULL REFERENCES pan_vault(id) ON DELETE CASCADE,
    issue_key TEXT NOT NULL,
    issue_name TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    outcome TEXT NOT NULL,
    shares_applied INTEGER,
    shares_allotted INTEGER,
    applicant_mask TEXT,
    error TEXT,
    checked_at REAL NOT NULL,
    UNIQUE (pan_id, issue_key, source)
);
CREATE INDEX IF NOT EXISTS idx_allot_lookup ON allotment_results(pan_id, issue_key);
"""


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        # WAL lets scheduler snapshot writes and portfolio reads/writes proceed
        # concurrently instead of throwing "database is locked" at each other
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        # outcome vocabulary rename (not_found -> not_applied); idempotent
        try:
            conn.execute("UPDATE allotment_results SET outcome = 'not_applied' WHERE outcome = 'not_found'")
        except Exception:
            pass


def save_snapshot(kind: str, payload: dict) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO snapshots (kind, payload, fetched_at) VALUES (?, ?, ?)",
            (kind, json.dumps(payload, ensure_ascii=False), time.time()),
        )


def latest_snapshot(kind: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT payload, fetched_at FROM snapshots WHERE kind = ? "
            "ORDER BY fetched_at DESC LIMIT 1",
            (kind,),
        ).fetchone()
    if row is None:
        return None
    return {"data": json.loads(row["payload"]), "fetched_at": row["fetched_at"]}


def history(kind: str, limit: int = 500) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT payload, fetched_at FROM snapshots WHERE kind = ? "
            "ORDER BY fetched_at DESC LIMIT ?",
            (kind, limit),
        ).fetchall()
    return [
        {"data": json.loads(r["payload"]), "fetched_at": r["fetched_at"]} for r in rows
    ]


# ---- portfolio holdings (user-owned rows, not market snapshots) ----


def list_holdings() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, asset_type, symbol, name, quantity, avg_price, created_at, updated_at "
            "FROM holdings ORDER BY asset_type, symbol"
        ).fetchall()
    return [dict(r) for r in rows]


def upsert_holding(asset_type: str, symbol: str, name: str, quantity: float, avg_price: float) -> dict:
    now = time.time()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO holdings (asset_type, symbol, name, quantity, avg_price, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (asset_type, symbol) DO UPDATE SET "
            "name = excluded.name, quantity = excluded.quantity, avg_price = excluded.avg_price, "
            "updated_at = excluded.updated_at",
            (asset_type, symbol, name, quantity, avg_price, now, now),
        )
        row = conn.execute(
            "SELECT id, asset_type, symbol, name, quantity, avg_price, created_at, updated_at "
            "FROM holdings WHERE asset_type = ? AND symbol = ?",
            (asset_type, symbol),
        ).fetchone()
    return dict(row)


def update_holding(holding_id: int, quantity: float, avg_price: float) -> dict | None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE holdings SET quantity = ?, avg_price = ?, updated_at = ? WHERE id = ?",
            (quantity, avg_price, time.time(), holding_id),
        )
        row = conn.execute(
            "SELECT id, asset_type, symbol, name, quantity, avg_price, created_at, updated_at "
            "FROM holdings WHERE id = ?",
            (holding_id,),
        ).fetchone()
    return dict(row) if row else None


def delete_holding(holding_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM holdings WHERE id = ?", (holding_id,))
    return cur.rowcount > 0


# ---- paper trading (simulated orders filled at live prices) ----

PAPER_STARTING_CASH = 1_000_000.0


def paper_account_row() -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, cash, starting_cash, created_at, updated_at FROM paper_account WHERE id = 1"
        ).fetchone()
        if row is None:
            now = time.time()
            conn.execute(
                "INSERT INTO paper_account (id, cash, starting_cash, created_at, updated_at) "
                "VALUES (1, ?, ?, ?, ?)",
                (PAPER_STARTING_CASH, PAPER_STARTING_CASH, now, now),
            )
            row = conn.execute(
                "SELECT id, cash, starting_cash, created_at, updated_at FROM paper_account WHERE id = 1"
            ).fetchone()
    return dict(row)


def paper_set_cash(cash: float) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE paper_account SET cash = ?, updated_at = ? WHERE id = 1",
            (round(cash, 2), time.time()),
        )


def paper_positions() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT symbol, name, quantity, avg_price, realized_pnl, updated_at "
            "FROM paper_positions ORDER BY symbol"
        ).fetchall()
    return [dict(r) for r in rows]


def paper_position(symbol: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT symbol, name, quantity, avg_price, realized_pnl, updated_at "
            "FROM paper_positions WHERE symbol = ?",
            (symbol,),
        ).fetchone()
    return dict(row) if row else None


def paper_upsert_position(symbol: str, name: str, quantity: float, avg_price: float, realized_pnl: float) -> None:
    now = time.time()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO paper_positions (symbol, name, quantity, avg_price, realized_pnl, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (symbol) DO UPDATE SET "
            "name = excluded.name, quantity = excluded.quantity, avg_price = excluded.avg_price, "
            "realized_pnl = excluded.realized_pnl, updated_at = excluded.updated_at",
            (symbol, name, round(quantity, 4), round(avg_price, 4), round(realized_pnl, 2), now),
        )


def paper_delete_position(symbol: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM paper_positions WHERE symbol = ?", (symbol,))


def paper_add_order(side: str, symbol: str, quantity: float, price: float, realized_pnl: float | None) -> dict:
    now = time.time()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO paper_orders (side, symbol, quantity, price, value, realized_pnl, ts) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (side, symbol, round(quantity, 4), round(price, 2), round(quantity * price, 2), realized_pnl, now),
        )
        row = conn.execute("SELECT * FROM paper_orders WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


def paper_orders(limit: int = 30) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, side, symbol, quantity, price, value, realized_pnl, ts "
            "FROM paper_orders ORDER BY ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def paper_reset() -> dict:
    now = time.time()
    with get_conn() as conn:
        conn.execute("DELETE FROM paper_positions")
        conn.execute("DELETE FROM paper_orders")
        conn.execute("DELETE FROM paper_limit_orders WHERE status = 'OPEN'")
        conn.execute("DELETE FROM paper_equity_history")
        conn.execute(
            "INSERT INTO paper_equity_history (equity, cash, positions_value, ts) VALUES (?, ?, 0, ?)",
            (PAPER_STARTING_CASH, PAPER_STARTING_CASH, now),
        )
        conn.execute(
            "INSERT INTO paper_account (id, cash, starting_cash, created_at, updated_at) "
            "VALUES (1, ?, ?, ?, ?) "
            "ON CONFLICT (id) DO UPDATE SET cash = excluded.cash, updated_at = excluded.updated_at",
            (PAPER_STARTING_CASH, PAPER_STARTING_CASH, now, now),
        )
    return paper_account_row()


def log_paper_equity(equity: float, cash: float, positions_value: float) -> None:
    now = time.time()
    with get_conn() as conn:
        last = conn.execute("SELECT id, ts FROM paper_equity_history ORDER BY ts DESC LIMIT 1").fetchone()
        if last and (now - last["ts"]) < 60:
            conn.execute(
                "UPDATE paper_equity_history SET equity = ?, cash = ?, positions_value = ?, ts = ? WHERE id = ?",
                (round(equity, 2), round(cash, 2), round(positions_value, 2), now, last["id"]),
            )
        else:
            conn.execute(
                "INSERT INTO paper_equity_history (equity, cash, positions_value, ts) VALUES (?, ?, ?, ?)",
                (round(equity, 2), round(cash, 2), round(positions_value, 2), now),
            )


def paper_equity_history(limit: int = 150) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT equity, cash, positions_value, ts FROM paper_equity_history ORDER BY ts ASC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


# ---- signal tracker (outlook BUY/SELL outcomes) ----


def log_signal(symbol: str, signal: str, score: float, entry: float, stop: float | None,
               target_1: float | None, target_2: float | None, horizon_days: int) -> None:
    now = time.time()
    with get_conn() as conn:
        open_row = conn.execute(
            "SELECT id, signal FROM signal_log WHERE symbol = ? AND resolved = 0 "
            "ORDER BY planned_at DESC LIMIT 1",
            (symbol,),
        ).fetchone()
        if open_row is not None:
            if open_row["signal"] == signal:
                return
            conn.execute(
                "UPDATE signal_log SET resolved = 1, outcome = 'superseded', resolved_at = ? WHERE id = ?",
                (now, open_row["id"]),
            )
        conn.execute(
            "INSERT INTO signal_log (symbol, signal, score, entry, stop, target_1, target_2, "
            "horizon_days, planned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (symbol, signal, score, entry, stop, target_1, target_2, horizon_days, now),
        )


def open_signals() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM signal_log WHERE resolved = 0 ORDER BY planned_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def resolve_signal(signal_id: int, outcome: str, exit_price: float, r_multiple: float | None) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE signal_log SET resolved = 1, outcome = ?, exit_price = ?, r_multiple = ?, "
            "resolved_at = ? WHERE id = ?",
            (outcome, round(exit_price, 2), round(r_multiple, 2) if r_multiple is not None else None,
             time.time(), signal_id),
        )


def recent_signals(limit: int = 50) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM signal_log ORDER BY planned_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


# ---- dividends ----


def add_dividend(symbol: str, amount_total: float, ex_date: str | None, note: str | None) -> dict:
    now = time.time()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO dividends (symbol, amount_total, ex_date, note, ts) VALUES (?, ?, ?, ?, ?)",
            (symbol.upper(), round(amount_total, 2), ex_date, note, now),
        )
        row = conn.execute("SELECT * FROM dividends WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


def list_dividends() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, symbol, amount_total, ex_date, note, ts FROM dividends ORDER BY ts DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def delete_dividend(div_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM dividends WHERE id = ?", (div_id,))
    return cur.rowcount > 0


# ---- paper limit orders ----


def add_limit_order(side: str, symbol: str, name: str, quantity: float, limit_price: float) -> dict:
    now = time.time()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO paper_limit_orders (side, symbol, name, quantity, limit_price, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (side, symbol, name, round(quantity, 4), round(limit_price, 2), now),
        )
        row = conn.execute("SELECT * FROM paper_limit_orders WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


def open_limit_orders() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM paper_limit_orders WHERE status = 'OPEN' ORDER BY created_at"
        ).fetchall()
    return [dict(r) for r in rows]


def fill_limit_order(order_id: int, filled_price: float) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE paper_limit_orders SET status = 'FILLED', filled_at = ?, filled_price = ? WHERE id = ?",
            (time.time(), round(filled_price, 2), order_id),
        )


def cancel_limit_order(order_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE paper_limit_orders SET status = 'CANCELLED' WHERE id = ? AND status = 'OPEN'",
            (order_id,),
        )
    return cur.rowcount > 0


# ---- IPO allotment: PAN vault + cached results ----
# NOTE: full PANs live ONLY in pan_vault.pan. Every reader outside this module
# must mask before returning/logging (see fetchers/allotment.py: mask_pan).


def pan_list() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, label, pan, created_at FROM pan_vault ORDER BY id"
        ).fetchall()
    return [dict(r) for r in rows]


def pan_get(pan_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, label, pan, created_at FROM pan_vault WHERE id = ?", (pan_id,)
        ).fetchone()
    return dict(row) if row else None


def pan_add(label: str, pan: str) -> dict:
    now = time.time()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO pan_vault (label, pan, created_at) VALUES (?, ?, ?)",
            (label.strip()[:40], pan.strip().upper(), now),
        )
        row = conn.execute("SELECT id, label, pan, created_at FROM pan_vault WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


def pan_delete(pan_id: int) -> bool:
    with get_conn() as conn:
        conn.execute("DELETE FROM allotment_results WHERE pan_id = ?", (pan_id,))
        cur = conn.execute("DELETE FROM pan_vault WHERE id = ?", (pan_id,))
    return cur.rowcount > 0


def allot_upsert(pan_id: int, issue_key: str, issue_name: str, source: str, outcome: str,
                 shares_applied: int | None = None, shares_allotted: int | None = None,
                 applicant_mask: str | None = None, error: str | None = None) -> None:
    now = time.time()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO allotment_results "
            "(pan_id, issue_key, issue_name, source, outcome, shares_applied, shares_allotted, "
            "applicant_mask, error, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (pan_id, issue_key, source) DO UPDATE SET "
            "issue_name = excluded.issue_name, outcome = excluded.outcome, "
            "shares_applied = excluded.shares_applied, shares_allotted = excluded.shares_allotted, "
            "applicant_mask = excluded.applicant_mask, error = excluded.error, "
            "checked_at = excluded.checked_at",
            (pan_id, issue_key, issue_name[:120], source, outcome, shares_applied,
             shares_allotted, (applicant_mask or "")[:40], (error or "")[:200], now),
        )


def allot_results(pan_id: int | None = None, max_age_s: float | None = None) -> list[dict]:
    q = "SELECT * FROM allotment_results"
    args: list = []
    clauses = []
    if pan_id is not None:
        clauses.append("pan_id = ?")
        args.append(pan_id)
    if max_age_s is not None:
        clauses.append("checked_at > ?")
        args.append(time.time() - max_age_s)
    if clauses:
        q += " WHERE " + " AND ".join(clauses)
    q += " ORDER BY checked_at DESC"
    with get_conn() as conn:
        rows = conn.execute(q, args).fetchall()
    return [dict(r) for r in rows]


def allot_delete_source(pan_id: int, issue_key: str, source: str) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM allotment_results WHERE pan_id = ? AND issue_key = ? AND source = ?",
            (pan_id, issue_key, source),
        )
    return cur.rowcount > 0


def recent_limit_orders(limit: int = 20) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM paper_limit_orders ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]
