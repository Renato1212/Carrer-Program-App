"""Trading journal + performance lab (SQLite, zero external services).

Day 1 principle baked in: performance is judged on COMBINED key metrics -
expectancy, profit factor, R-distribution, win/loss asymmetry - never win
rate alone. Each trade carries a setup tag and a principles audit so leaks
are visible by playbook.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "journal.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('long','short')),
    setup TEXT,
    contracts REAL DEFAULT 1,
    entry REAL NOT NULL,
    stop REAL,
    target REAL,
    exit REAL NOT NULL,
    pnl_ticks REAL,
    pnl_usd REAL,
    r_multiple REAL,
    planned INTEGER DEFAULT 1,
    followed_plan INTEGER DEFAULT 1,
    style_drift INTEGER DEFAULT 0,
    notes TEXT,
    created TEXT DEFAULT CURRENT_TIMESTAMP
);
"""

TICKS = {"ES": (0.25, 12.5), "NQ": (0.25, 5.0), "YM": (1.0, 5.0), "RTY": (0.1, 5.0),
         "CL": (0.01, 10.0), "GC": (0.1, 10.0), "SI": (0.005, 25.0), "NG": (0.001, 10.0),
         "ZB": (0.03125, 31.25), "ZN": (0.015625, 15.625), "6E": (0.00005, 6.25),
         "BTC": (5.0, 25.0), "HG": (0.0005, 12.5), "ZF": (0.0078125, 7.8125), "6J": (0.0000005, 6.25)}


def _conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute(SCHEMA)
    return c


def add_trade(t: dict) -> dict:
    sym = t["symbol"].upper()
    tick, tick_val = TICKS.get(sym, (0.25, 12.5))
    sign = 1 if t["direction"] == "long" else -1
    move = (float(t["exit"]) - float(t["entry"])) * sign
    pnl_ticks = move / tick
    pnl_usd = pnl_ticks * tick_val * float(t.get("contracts", 1))
    r = None
    if t.get("stop") not in (None, "", 0):
        risk = abs(float(t["entry"]) - float(t["stop"]))
        if risk > 0:
            r = round(move / risk, 2)
    with _conn() as c:
        cur = c.execute(
            """INSERT INTO trades (ts, symbol, direction, setup, contracts, entry, stop, target,
               exit, pnl_ticks, pnl_usd, r_multiple, planned, followed_plan, style_drift, notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (t.get("ts") or datetime.now().isoformat(timespec="minutes"), sym, t["direction"],
             t.get("setup", ""), float(t.get("contracts", 1)), float(t["entry"]),
             float(t["stop"]) if t.get("stop") not in (None, "") else None,
             float(t["target"]) if t.get("target") not in (None, "") else None,
             float(t["exit"]), round(pnl_ticks, 2), round(pnl_usd, 2), r,
             int(bool(t.get("planned", True))), int(bool(t.get("followed_plan", True))),
             int(bool(t.get("style_drift", False))), t.get("notes", "")))
        return {"ok": True, "id": cur.lastrowid, "pnl_usd": round(pnl_usd, 2), "r_multiple": r}


def delete_trade(trade_id: int) -> dict:
    with _conn() as c:
        c.execute("DELETE FROM trades WHERE id=?", (trade_id,))
    return {"ok": True}


def list_trades(limit: int = 200) -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT * FROM trades ORDER BY ts DESC, id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def metrics() -> dict:
    trades = list_trades(limit=5000)
    if not trades:
        return {"ok": True, "count": 0}
    pnls = [t["pnl_usd"] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    rs = [t["r_multiple"] for t in trades if t["r_multiple"] is not None]
    gross_w, gross_l = sum(wins), abs(sum(losses))
    win_rate = len(wins) / len(pnls)
    avg_w = gross_w / len(wins) if wins else 0
    avg_l = gross_l / len(losses) if losses else 0
    expectancy = win_rate * avg_w - (1 - win_rate) * avg_l

    # equity curve + max drawdown
    chron = sorted(trades, key=lambda t: (t["ts"], t["id"]))
    eq, peak, max_dd, curve = 0.0, 0.0, 0.0, []
    for t in chron:
        eq += t["pnl_usd"]
        peak = max(peak, eq)
        max_dd = max(max_dd, peak - eq)
        curve.append({"ts": t["ts"], "equity": round(eq, 2)})

    by_setup: dict[str, dict] = {}
    for t in trades:
        s = t["setup"] or "(untagged)"
        b = by_setup.setdefault(s, {"n": 0, "pnl": 0.0, "wins": 0, "rs": []})
        b["n"] += 1
        b["pnl"] += t["pnl_usd"]
        b["wins"] += 1 if t["pnl_usd"] > 0 else 0
        if t["r_multiple"] is not None:
            b["rs"].append(t["r_multiple"])
    setup_table = [{"setup": s, "n": b["n"], "pnl": round(b["pnl"], 2),
                    "win_rate": round(b["wins"] / b["n"] * 100, 1),
                    "avg_r": round(sum(b["rs"]) / len(b["rs"]), 2) if b["rs"] else None}
                   for s, b in sorted(by_setup.items(), key=lambda kv: -kv[1]["pnl"])]

    audits = []
    no_stop = sum(1 for t in trades if t["stop"] is None)
    drift = sum(1 for t in trades if t["style_drift"])
    off_plan = sum(1 for t in trades if not t["followed_plan"])
    unplanned = sum(1 for t in trades if not t["planned"])
    big_losses = [t for t in trades if rs and t["r_multiple"] is not None and t["r_multiple"] <= -1.5]
    if no_stop:
        audits.append(f"{no_stop} trade(s) logged without a stop - undefined risk breaks every Day 5 asymmetry rule.")
    if drift:
        audits.append(f"{drift} trade(s) flagged style drift (scalp->swing or vice versa) - Day 5: organize yourself.")
    if off_plan:
        audits.append(f"{off_plan} trade(s) deviated from plan - measure the cost of each deviation.")
    if unplanned:
        audits.append(f"{unplanned} impulse trade(s) - Day 1: when uncertain, reduce size or don't trade.")
    if big_losses:
        audits.append(f"{len(big_losses)} loss(es) beyond -1.5R - cutting losers fast is rule #1.")
    cut_fast = [abs(r) for r in rs if r < 0]
    let_run = [r for r in rs if r > 0]
    if cut_fast and let_run and (sum(let_run)/len(let_run)) < (sum(cut_fast)/len(cut_fast)):
        audits.append("Average winner (R) is smaller than average loser (R) - inverted asymmetry; revisit Day 5 target selection.")

    return {
        "ok": True, "count": len(trades),
        "net_pnl": round(sum(pnls), 2),
        "win_rate": round(win_rate * 100, 1),
        "profit_factor": round(gross_w / gross_l, 2) if gross_l else None,
        "expectancy_usd": round(expectancy, 2),
        "avg_win": round(avg_w, 2), "avg_loss": round(avg_l, 2),
        "avg_r": round(sum(rs) / len(rs), 2) if rs else None,
        "best_r": max(rs) if rs else None, "worst_r": min(rs) if rs else None,
        "max_drawdown": round(max_dd, 2),
        "equity_curve": curve, "by_setup": setup_table, "principle_audit": audits,
    }
