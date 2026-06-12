"""Simulated trading account for the DOM panel.

SQLite-backed paper account: market/limit/stop orders with optional bracket
(stop-loss + take-profit, OCO), a fill engine driven by the DOM snapshot,
FIFO position accounting in real contract dollars, and a performance
dashboard. Closed round-trips are auto-logged into the main journal tagged
`sim-dom` so the journal's principle audit covers sim trading too.
"""
from __future__ import annotations

import sqlite3
import time
from datetime import datetime

from backend.services import journal

DB_PATH = journal.DB_PATH          # same db file, separate tables
START_BALANCE = 100_000.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS sim_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, symbol TEXT, side TEXT, qty INTEGER,
    otype TEXT, price REAL,
    status TEXT DEFAULT 'open',
    filled_price REAL, filled_ts REAL,
    role TEXT DEFAULT 'entry', oco INTEGER
);
CREATE TABLE IF NOT EXISTS sim_state (
    symbol TEXT PRIMARY KEY, pos INTEGER DEFAULT 0, avg REAL DEFAULT 0,
    entry_ts REAL
);
CREATE TABLE IF NOT EXISTS sim_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, symbol TEXT, side TEXT, qty INTEGER,
    entry REAL, exit REAL, pnl REAL
);
CREATE TABLE IF NOT EXISTS sim_meta (k TEXT PRIMARY KEY, v REAL);
"""


def _conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.executescript(SCHEMA)
    return c


def _dollars(symbol: str, price_move: float) -> float:
    tick, tick_val = journal.TICKS.get(symbol, (0.25, 12.5))
    return price_move / tick * tick_val


def _realized(c) -> float:
    row = c.execute("SELECT COALESCE(SUM(pnl),0) p FROM sim_trades").fetchone()
    return float(row["p"])


def place_order(symbol: str, side: str, qty: int, otype: str = "market",
                price: float | None = None, stop_loss: float | None = None,
                take_profit: float | None = None) -> dict:
    symbol, side, otype = symbol.upper(), side.lower(), otype.lower()
    if side not in ("buy", "sell") or otype not in ("market", "limit", "stop"):
        return {"ok": False, "error": "side must be buy/sell; type market/limit/stop"}
    qty = max(1, min(int(qty or 1), 50))
    if otype in ("limit", "stop") and not price:
        return {"ok": False, "error": f"{otype} orders need a price"}
    with _conn() as c:
        oco = int(time.time() * 1000) if (stop_loss or take_profit) else None
        cur = c.execute(
            "INSERT INTO sim_orders (ts,symbol,side,qty,otype,price,role,oco) VALUES (?,?,?,?,?,?,?,?)",
            (time.time(), symbol, side, qty, otype, price, "entry", oco))
        oid = cur.lastrowid
        exit_side = "sell" if side == "buy" else "buy"
        if stop_loss:
            c.execute("INSERT INTO sim_orders (ts,symbol,side,qty,otype,price,role,oco,status) "
                      "VALUES (?,?,?,?,?,?,?,?,'pending')",
                      (time.time(), symbol, exit_side, qty, "stop", stop_loss, "stop", oco))
        if take_profit:
            c.execute("INSERT INTO sim_orders (ts,symbol,side,qty,otype,price,role,oco,status) "
                      "VALUES (?,?,?,?,?,?,?,?,'pending')",
                      (time.time(), symbol, exit_side, qty, "limit", take_profit, "target", oco))
    return {"ok": True, "id": oid}


def cancel_order(order_id: int) -> dict:
    with _conn() as c:
        c.execute("UPDATE sim_orders SET status='cancelled' WHERE id=? AND status IN ('open','pending')",
                  (order_id,))
    return {"ok": True}


def flatten(symbol: str, last: float) -> dict:
    with _conn() as c:
        st = c.execute("SELECT * FROM sim_state WHERE symbol=?", (symbol,)).fetchone()
        c.execute("UPDATE sim_orders SET status='cancelled' WHERE symbol=? AND status IN ('open','pending')",
                  (symbol,))
        if st and st["pos"]:
            _close_position(c, symbol, -st["pos"], last, st)
    return {"ok": True}


def _close_position(c, symbol: str, qty_signed: int, price: float, st):
    """Reduce/close position; qty_signed negative reduces a long, etc."""
    pos, avg = st["pos"], st["avg"]
    closing = min(abs(qty_signed), abs(pos))
    direction = 1 if pos > 0 else -1
    pnl = _dollars(symbol, (price - avg) * direction) * closing
    c.execute("INSERT INTO sim_trades (ts,symbol,side,qty,entry,exit,pnl) VALUES (?,?,?,?,?,?,?)",
              (time.time(), symbol, "long" if direction > 0 else "short", closing, avg, price, pnl))
    new_pos = pos + qty_signed if abs(qty_signed) <= abs(pos) else 0
    c.execute("UPDATE sim_state SET pos=?, avg=? WHERE symbol=?",
              (new_pos, avg if new_pos else 0, symbol))
    try:
        journal.add_trade({"symbol": symbol, "direction": "long" if direction > 0 else "short",
                           "entry": avg, "exit": price, "contracts": closing,
                           "setup": "sim-dom", "notes": "simulated DOM trade",
                           "ts": datetime.now().isoformat(timespec="minutes")})
    except Exception:
        pass


def _apply_fill(c, o, fill_price: float):
    c.execute("UPDATE sim_orders SET status='filled', filled_price=?, filled_ts=? WHERE id=?",
              (fill_price, time.time(), o["id"]))
    symbol = o["symbol"]
    signed = o["qty"] if o["side"] == "buy" else -o["qty"]
    st = c.execute("SELECT * FROM sim_state WHERE symbol=?", (symbol,)).fetchone()
    if st is None:
        c.execute("INSERT INTO sim_state (symbol,pos,avg,entry_ts) VALUES (?,?,?,?)",
                  (symbol, 0, 0, time.time()))
        st = c.execute("SELECT * FROM sim_state WHERE symbol=?", (symbol,)).fetchone()
    pos, avg = st["pos"], st["avg"]
    if pos == 0 or (pos > 0) == (signed > 0):
        new_pos = pos + signed
        new_avg = (abs(pos) * avg + abs(signed) * fill_price) / abs(new_pos)
        c.execute("UPDATE sim_state SET pos=?, avg=?, entry_ts=? WHERE symbol=?",
                  (new_pos, new_avg, time.time(), symbol))
    else:
        _close_position(c, symbol, signed, fill_price, st)
        st2 = c.execute("SELECT * FROM sim_state WHERE symbol=?", (symbol,)).fetchone()
        leftover = pos + signed
        if abs(signed) > abs(pos):   # reversal: open remainder the other way
            c.execute("UPDATE sim_state SET pos=?, avg=?, entry_ts=? WHERE symbol=?",
                      (leftover, fill_price, time.time(), symbol))
    # entry fill activates its bracket children; exit fill cancels OCO sibling
    if o["oco"]:
        if o["role"] == "entry":
            c.execute("UPDATE sim_orders SET status='open' WHERE oco=? AND role!='entry' AND status='pending'",
                      (o["oco"],))
        else:
            c.execute("UPDATE sim_orders SET status='cancelled' WHERE oco=? AND id!=? "
                      "AND status IN ('open','pending')", (o["oco"], o["id"]))


def process(symbol: str, last: float, bid: float, ask: float) -> None:
    """Fill engine: called on every DOM snapshot."""
    with _conn() as c:
        orders = c.execute("SELECT * FROM sim_orders WHERE symbol=? AND status='open' ORDER BY id",
                           (symbol,)).fetchall()
        for o in orders:
            ot, side, px = o["otype"], o["side"], o["price"]
            if ot == "market":
                _apply_fill(c, o, ask if side == "buy" else bid)
            elif ot == "limit":
                if side == "buy" and last <= px:
                    _apply_fill(c, o, px)
                elif side == "sell" and last >= px:
                    _apply_fill(c, o, px)
            elif ot == "stop":
                if side == "buy" and last >= px:
                    _apply_fill(c, o, max(px, ask))
                elif side == "sell" and last <= px:
                    _apply_fill(c, o, min(px, bid))


def account(symbol: str, last: float) -> dict:
    with _conn() as c:
        realized = _realized(c)
        st = c.execute("SELECT * FROM sim_state WHERE symbol=?", (symbol,)).fetchone()
        pos = st["pos"] if st else 0
        avg = st["avg"] if st else 0
        unreal = _dollars(symbol, (last - avg) * (1 if pos > 0 else -1)) * abs(pos) if pos else 0.0
        open_orders = [dict(o) for o in c.execute(
            "SELECT * FROM sim_orders WHERE symbol=? AND status='open' ORDER BY id DESC LIMIT 12",
            (symbol,))]
        return {
            "balance": round(START_BALANCE + realized, 2),
            "equity": round(START_BALANCE + realized + unreal, 2),
            "realized": round(realized, 2),
            "unrealized": round(unreal, 2),
            "position": pos, "avg_price": round(avg, 4) if pos else None,
            "open_orders": open_orders,
        }


def dashboard() -> dict:
    with _conn() as c:
        trades = [dict(r) for r in c.execute("SELECT * FROM sim_trades ORDER BY ts DESC LIMIT 200")]
    if not trades:
        return {"ok": True, "count": 0, "balance": START_BALANCE,
                "note": "No simulated round-trips yet - place trades from the DOM to build the track record."}
    pnls = [t["pnl"] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    eq, curve = START_BALANCE, []
    for t in sorted(trades, key=lambda x: x["ts"]):
        eq += t["pnl"]
        curve.append({"ts": datetime.fromtimestamp(t["ts"]).isoformat(timespec="minutes"),
                      "equity": round(eq, 2)})
    return {
        "ok": True, "count": len(trades),
        "balance": round(START_BALANCE + sum(pnls), 2),
        "net_pnl": round(sum(pnls), 2),
        "win_rate": round(len(wins) / len(pnls) * 100, 1),
        "avg_win": round(sum(wins) / len(wins), 2) if wins else 0,
        "avg_loss": round(abs(sum(losses) / len(losses)), 2) if losses else 0,
        "profit_factor": round(sum(wins) / abs(sum(losses)), 2) if losses else None,
        "equity_curve": curve,
        "recent": [{"ts": datetime.fromtimestamp(t["ts"]).isoformat(timespec="minutes"),
                    "symbol": t["symbol"], "side": t["side"], "qty": t["qty"],
                    "entry": t["entry"], "exit": t["exit"], "pnl": round(t["pnl"], 2)}
                   for t in trades[:25]],
    }


def reset_account() -> dict:
    with _conn() as c:
        for tbl in ("sim_orders", "sim_state", "sim_trades"):
            c.execute(f"DELETE FROM {tbl}")
    return {"ok": True}
