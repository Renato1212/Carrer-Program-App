"""Simulated order book (DOM) engine, anchored to real market prices.

HONESTY FIRST: free data feeds carry no market-by-order book. This engine
keeps the PRICE real (delayed quote anchor; live Rithmic BBO/trades when
connected) while simulating realistic book liquidity around it - resting
sizes, pulls/stacks, icebergs, sweeps and stop-runs. That makes it a
training DOM: tape-reading and execution practice with detection analytics
(delta, cancellation rate, iceberg refills, stop sweeps) computed exactly
the way they would be on a real feed.
"""
from __future__ import annotations

import random
import threading
import time

from backend.services import market_data as md
from backend.services import rithmic

LEVELS = 15            # rows above and below the inside market
_books: dict[str, dict] = {}
_lock = threading.Lock()


def _tick(symbol: str) -> float:
    return md.INSTRUMENTS.get(symbol, {}).get("tick", 0.25)


def _round_tick(px: float, tick: float) -> float:
    return round(round(px / tick) * tick, 10)


def _new_book(symbol: str, anchor: float) -> dict:
    tick = _tick(symbol)
    rng = random.Random(hash(symbol) & 0xFFFF)
    return {
        "symbol": symbol, "tick": tick,
        "last": _round_tick(anchor, tick),
        "sizes": {},                       # price -> {"bid": n, "ask": n}
        "trades": [],                      # recent tape
        "vp": {},                          # price -> traded volume (session)
        "cum_delta": 0,
        "delta_hist": [],
        "signals": [],
        "iceberg": None,                   # {"price", "side", "hidden", "shown"}
        "hi": anchor, "lo": anchor,
        "cancels": 0, "adds": 0,
        "rng": rng,
        "t0": time.time(),
    }


def _real_anchor(symbol: str):
    live = rithmic.live_quote(symbol)
    if live and live.get("last"):
        return float(live["last"]), "rithmic-live", live
    q = md.get_quote(symbol)
    if q.get("ok") and q.get("last"):
        return float(q["last"]), q.get("source", "delayed (Yahoo)"), None
    return None, "unavailable", None


def _size_at(b: dict, price: float, side: str) -> int:
    s = b["sizes"].setdefault(price, {})
    if side not in s:
        base = b["rng"].randint(8, 60)
        s[side] = base
    return s[side]


def _signal(b: dict, kind: str, text: str):
    b["signals"].append({"ts": time.time(), "kind": kind, "text": text})
    del b["signals"][:-10]


def step(symbol: str) -> dict:
    """Advance the simulation one frame and return a full DOM snapshot."""
    anchor, source, live = _real_anchor(symbol)
    with _lock:
        b = _books.get(symbol)
        if b is None:
            if anchor is None:
                return {"ok": False, "error": "no price anchor available - data source unreachable"}
            b = _books[symbol] = _new_book(symbol, anchor)
        tick, rng = b["tick"], b["rng"]

        # ---- price evolution: drift toward the real anchor with micro-noise ----
        target = anchor if anchor is not None else b["last"]
        gap_ticks = (target - b["last"]) / tick
        move = 0
        if abs(gap_ticks) >= 1:
            move = max(-3, min(3, int(gap_ticks)))             # converge to reality
        elif rng.random() < 0.55:
            move = rng.choice([-1, 0, 0, 1])
        new_last = _round_tick(b["last"] + move * tick, tick)

        # ---- generate tape between old and new price ----
        path = []
        px = b["last"]
        steps = max(1, abs(int(round((new_last - px) / tick))))
        for _ in range(steps):
            px = _round_tick(px + (tick if new_last > px else -tick if new_last < px else 0), tick)
            path.append(px)
        if not path:
            path = [b["last"]]
        frame_delta = 0
        for p in path:
            n_tr = rng.randint(1, 3)
            for _ in range(n_tr):
                side = "buy" if (move > 0 or (move == 0 and rng.random() < 0.5)) else "sell"
                size = rng.choice([1, 1, 2, 2, 3, 5, 8, 12, 20, rng.randint(20, 80)])
                # iceberg absorbs aggressive flow at its level
                ice = b["iceberg"]
                if ice and abs(p - ice["price"]) < tick / 2 and ice["hidden"] > 0:
                    absorbed = min(size, ice["hidden"])
                    ice["hidden"] -= absorbed
                    if ice["hidden"] <= 0:
                        _signal(b, "iceberg-done",
                                f"Iceberg at {ice['price']:g} fully consumed - the {ice['side']} defense "
                                "is gone; the level can now travel.")
                        b["iceberg"] = None
                b["trades"].append({"ts": time.time(), "price": p, "size": size, "side": side})
                b["vp"][p] = b["vp"].get(p, 0) + size
                frame_delta += size if side == "buy" else -size
        del b["trades"][:-60]
        b["cum_delta"] += frame_delta
        b["delta_hist"].append(b["cum_delta"])
        del b["delta_hist"][:-180]
        prev_hi, prev_lo = b["hi"], b["lo"]
        b["hi"] = max(b["hi"], new_last)
        b["lo"] = min(b["lo"], new_last)

        # ---- stop-run detection: burst through session extreme ----
        if new_last > prev_hi + tick and move >= 2:
            _signal(b, "stop-run", f"Buy-side burst through {prev_hi:g} - resting buy stops above the "
                                   "session high just triggered. Watch for follow-through vs snap-back.")
        if new_last < prev_lo - tick and move <= -2:
            _signal(b, "stop-run", f"Sell-side burst through {prev_lo:g} - sell stops below the session "
                                   "low triggered. The first seconds decide: real break or stop-run trap.")

        # ---- book dynamics: adds, pulls, occasional events ----
        ladder_prices = [_round_tick(new_last + i * tick, tick) for i in range(-LEVELS, LEVELS + 1)]
        for p in ladder_prices:
            for side in ("bid", "ask"):
                cur = _size_at(b, p, side)
                if rng.random() < 0.30:
                    delta = rng.randint(-9, 10)
                    nxt = max(1, cur + delta)
                    if delta > 0:
                        b["adds"] += delta
                    else:
                        b["cancels"] += -delta
                    b["sizes"][p][side] = nxt
        # big pull (spoof-like cancellation)
        if rng.random() < 0.05:
            p = _round_tick(new_last + rng.choice([-3, -2, 2, 3]) * tick, tick)
            side = "bid" if p < new_last else "ask"
            cur = _size_at(b, p, side)
            if cur > 40:
                b["sizes"][p][side] = max(2, int(cur * 0.2))
                b["cancels"] += cur
                _signal(b, "cancel", f"Large {side} at {p:g} pulled ({cur} lots cancelled) - the size "
                                     "was never meant to trade. Liquidity you lean on can vanish.")
        # spawn iceberg
        if b["iceberg"] is None and rng.random() < 0.06:
            off = rng.choice([-4, -3, 3, 4])
            p = _round_tick(new_last + off * tick, tick)
            side = "bid" if off < 0 else "ask"
            b["iceberg"] = {"price": p, "side": side, "hidden": rng.randint(150, 450), "shown": 12}
            _signal(b, "iceberg", f"Iceberg detected on the {side} at {p:g}: the visible size keeps "
                                  "refilling after every hit - someone large is absorbing there. "
                                  "Join it with risk behind the level, or wait for it to finish.")
        # iceberg keeps its shown size refilled
        ice = b["iceberg"]
        if ice:
            side_key = "bid" if ice["side"] == "bid" else "ask"
            b["sizes"].setdefault(ice["price"], {})[side_key] = ice["shown"]

        b["last"] = new_last

        # ---- live overlay when Rithmic is connected ----
        bid_px = _round_tick(new_last - tick, tick)
        ask_px = _round_tick(new_last + tick, tick)
        if live:
            if live.get("bid"):
                bid_px = _round_tick(float(live["bid"]), tick)
            if live.get("ask"):
                ask_px = _round_tick(float(live["ask"]), tick)

        ladder = []
        for i in range(LEVELS, -LEVELS - 1, -1):
            p = _round_tick(new_last + i * tick, tick)
            ladder.append({
                "price": p,
                "bid": _size_at(b, p, "bid") if p <= bid_px else 0,
                "ask": _size_at(b, p, "ask") if p >= ask_px else 0,
                "vol": int(b["vp"].get(p, 0)),
                "ice": bool(ice and abs(p - ice["price"]) < tick / 2),
            })
        total = b["adds"] + b["cancels"] or 1
        vp_sorted = sorted(b["vp"].items(), key=lambda kv: -kv[1])
        step_n = max(1, len(b["delta_hist"]) // 60)
        return {
            "ok": True, "symbol": symbol, "tick": tick,
            "source": source,
            "simulated_book": True,
            "last": new_last, "bid": bid_px, "ask": ask_px,
            "session_hi": b["hi"], "session_lo": b["lo"],
            "ladder": ladder,
            "tape": list(reversed(b["trades"][-18:])),
            "cum_delta": b["cum_delta"],
            "delta_hist": b["delta_hist"][::step_n],
            "cancel_ratio": round(b["cancels"] / total, 2),
            "poc": vp_sorted[0][0] if vp_sorted else None,
            "signals": list(reversed(b["signals"])),
            "note": ("Prices anchored to the real market"
                     + (" (LIVE Rithmic feed)" if source == "rithmic-live" else " (delayed quote)")
                     + "; book liquidity, icebergs and stop-runs are SIMULATED for execution training. "
                       "Connect Rithmic on a persistent host for real trades and BBO."),
        }


def reset(symbol: str) -> dict:
    with _lock:
        _books.pop(symbol, None)
    return {"ok": True}
