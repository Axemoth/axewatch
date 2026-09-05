"""Adaptive source-health tracking (circuit breaker).

Semantics, deliberately conservative so it can never make things WORSE than no
tracking at all:

- Failures mean transport-level trouble (429/403/5xx/timeout/exception).
  "Not found" outcomes (unknown symbol, empty search) are neutral: they carry
  no information about the source's health.
- 3 consecutive failures put a source in cooldown: 120 s first, doubling each
  further failure cycle, capped at 30 min. Any success resets the streak.
- Callers must treat `is_available()` as a HINT for choosing among alternative
  sources, never as a veto on the last remaining one (if everything is cooling
  down, try anyway — a slow retry beats no data).

Not instrumented: NSE cookie priming (homepage 403s are routine there while the
API calls themselves still succeed — counting them would cry wolf).
"""

import functools
import threading
import time
from collections import deque

_LOCK = threading.Lock()
_EVENTS: deque = deque(maxlen=200)
_SOURCES: dict[str, dict] = {}

BASE_COOLDOWN = 120.0
MAX_COOLDOWN = 1800.0
FAIL_THRESHOLD = 3


def _entry(name: str) -> dict:
    return _SOURCES.setdefault(
        name,
        {
            "name": name,
            "ok": 0,
            "fail": 0,
            "neutral": 0,
            "consecutive_failures": 0,
            "last_status": None,
            "last_error": None,
            "last_ok_ts": 0.0,
            "last_fail_ts": 0.0,
            "cooldown_until": 0.0,
            "cooldown_cycles": 0,
            "avg_latency": 0.0,
        },
    )


def record(
    name: str,
    *,
    ok: bool,
    latency: float = 0.0,
    status: int | None = None,
    error: Exception | str | None = None,
    neutral: bool = False,
) -> None:
    now = time.time()
    with _LOCK:
        e = _entry(name)
        e["last_status"] = status
        if neutral:
            e["neutral"] += 1
        elif ok:
            e["ok"] += 1
            e["consecutive_failures"] = 0
            e["cooldown_until"] = 0.0
            e["last_ok_ts"] = now
            # a single success must not whitewash a flapping source: keep the
            # escalation memory unless the source has been quiet for 30 min
            if now - e["last_fail_ts"] > 1800:
                e["cooldown_cycles"] = 0
            prev = e["avg_latency"]
            e["avg_latency"] = latency if e["ok"] == 1 else prev * 0.7 + latency * 0.3
        else:
            e["fail"] += 1
            e["consecutive_failures"] += 1
            e["last_fail_ts"] = now
            e["last_error"] = str(error)[:200] if error else None
            if e["consecutive_failures"] >= FAIL_THRESHOLD:
                e["cooldown_cycles"] += 1
                cooldown = min(BASE_COOLDOWN * 2 ** (e["cooldown_cycles"] - 1), MAX_COOLDOWN)
                e["cooldown_until"] = now + cooldown
        _EVENTS.append(
            {
                "ts": now,
                "source": name,
                "ok": bool(ok and not neutral),
                "neutral": neutral,
                "status": status,
                "latency_ms": round(latency * 1000, 1),
                "error": str(error)[:160] if error else None,
            }
        )


def record_response(name: str, status: int, latency: float, retry_after: float | None = None) -> None:
    """Record an HTTP response by status class: 2xx ok, 404 neutral, rest fail."""
    if 200 <= status < 400:
        record(name, ok=True, latency=latency, status=status)
    elif status == 404:
        record(name, ok=False, latency=latency, status=status, neutral=True)
    else:
        record(name, ok=False, latency=latency, status=status, error=f"HTTP {status}")
        if retry_after and retry_after > 0:
            with _LOCK:
                e = _entry(name)
                e["cooldown_until"] = max(
                    e["cooldown_until"], time.time() + min(retry_after, MAX_COOLDOWN)
                )


def is_available(name: str) -> bool:
    with _LOCK:
        e = _SOURCES.get(name)
        if not e:
            return True
        return e["cooldown_until"] <= time.time()


def is_degraded(name: str) -> bool:
    """Recent failures but not cooled down yet — worth backing off a little."""
    with _LOCK:
        e = _SOURCES.get(name)
        if not e:
            return False
        return e["consecutive_failures"] > 0 and e["cooldown_until"] <= time.time()


def tracked(name: str):
    """Decorator: record ok/fail + latency around a whole function call."""

    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            t0 = time.time()
            try:
                res = fn(*args, **kwargs)
            except Exception as exc:
                record(name, ok=False, latency=time.time() - t0, error=exc)
                raise
            record(name, ok=True, latency=time.time() - t0)
            return res

        return wrapper

    return deco


def snapshot() -> dict:
    now = time.time()
    with _LOCK:
        sources = []
        for e in _SOURCES.values():
            cooling = e["cooldown_until"] > now
            state = "cooling" if cooling else ("degraded" if e["consecutive_failures"] > 0 else "ok")
            total = e["ok"] + e["fail"]
            sources.append(
                {
                    "name": e["name"],
                    "state": state,
                    "ok": e["ok"],
                    "fail": e["fail"],
                    "neutral": e["neutral"],
                    "success_rate": round(e["ok"] / total * 100, 1) if total else None,
                    "avg_latency_ms": round(e["avg_latency"] * 1000, 0),
                    "consecutive_failures": e["consecutive_failures"],
                    "cooldown_remaining_s": round(e["cooldown_until"] - now, 0) if cooling else 0,
                    "last_error": e["last_error"],
                    "last_ok_ts": e["last_ok_ts"] or None,
                }
            )
        events = list(reversed(_EVENTS))[:60]
    return {"sources": sources, "events": events}
