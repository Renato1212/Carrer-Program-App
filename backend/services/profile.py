"""Market Profile / TPO + Volume Profile engine.

Implements the Day 6-9 program concepts on free Yahoo intraday data:
TPO letters, POC / value area, Initial Balance, day-type classification,
poor highs/lows, single prints, HVN/LVN detection and failed-auction checks.
"""
from __future__ import annotations

import math
import string
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from backend.services import market_data as md

ET = ZoneInfo("America/New_York")
TPO_LETTERS = string.ascii_uppercase + string.ascii_lowercase


def _bucket_size(symbol: str, day_range: float) -> float:
    """TPO row height: a few ticks, scaled so a day has ~30-60 rows."""
    tick = md.INSTRUMENTS.get(symbol, {}).get("tick", 0.25)
    if day_range <= 0:
        return tick
    raw = day_range / 45
    mult = max(1, round(raw / tick))
    return mult * tick


def _round_to(x: float, step: float) -> float:
    return round(round(x / step) * step, 10)


def build_tpo(symbol: str, session_df: pd.DataFrame) -> dict:
    """Build a TPO profile from 30-minute RTH bars."""
    hi, lo = float(session_df.High.max()), float(session_df.Low.min())
    step = _bucket_size(symbol, hi - lo)
    rows: dict[float, list[str]] = {}
    for i, (_, bar) in enumerate(session_df.iterrows()):
        letter = TPO_LETTERS[min(i, len(TPO_LETTERS) - 1)]
        p = _round_to(float(bar.Low), step)
        while p <= float(bar.High) + 1e-9:
            rows.setdefault(round(p, 10), []).append(letter)
            p = round(p + step, 10)
    prices = sorted(rows.keys(), reverse=True)
    counts = {p: len(rows[p]) for p in prices}
    total = sum(counts.values())

    # POC: row with most TPOs (closest to mid on ties)
    mid = (hi + lo) / 2
    poc = max(prices, key=lambda p: (counts[p], -abs(p - mid)))

    # Value area: expand from POC until 70% of TPOs covered
    va = {poc}
    covered = counts[poc]
    idx = {p: i for i, p in enumerate(prices)}
    while covered < 0.70 * total:
        lo_i = max(idx[p] for p in va)
        hi_i = min(idx[p] for p in va)
        below = prices[lo_i + 1] if lo_i + 1 < len(prices) else None
        above = prices[hi_i - 1] if hi_i - 1 >= 0 else None
        cb = counts.get(below, -1) if below is not None else -1
        ca = counts.get(above, -1) if above is not None else -1
        if cb < 0 and ca < 0:
            break
        if cb >= ca:
            va.add(below); covered += cb
        else:
            va.add(above); covered += ca
    vah, val = max(va), min(va)

    # Initial balance = first hour (two 30m bars)
    ib = session_df.iloc[:2]
    ib_high, ib_low = float(ib.High.max()), float(ib.Low.min())

    # Poor high/low: 2+ TPOs at the extreme row (unfinished auction).
    poor_high = counts[prices[0]] >= 2
    poor_low = counts[prices[-1]] >= 2
    # Single prints inside the profile (excluding the extremes' tails)
    singles = [p for p in prices[2:-2] if counts[p] == 1]

    o = float(session_df.iloc[0].Open)
    c = float(session_df.iloc[-1].Close)
    day_type = classify_day_type(o, c, hi, lo, ib_high, ib_low, counts, prices)
    failed = failed_auction(session_df, ib_high, ib_low)

    return {
        "ok": True,
        "symbol": symbol,
        "step": step,
        "open": o, "close": c, "high": hi, "low": lo,
        "poc": poc, "vah": vah, "val": val,
        "ib_high": ib_high, "ib_low": ib_low,
        "poor_high": poor_high, "poor_low": poor_low,
        "single_prints": singles[:20],
        "day_type": day_type,
        "failed_auction": failed,
        "rows": [{"price": p, "letters": "".join(rows[p]), "count": counts[p]} for p in prices],
    }


def classify_day_type(o, c, hi, lo, ibh, ibl, counts, prices) -> dict:
    """Day-type read per Day 7-8: trend / normal / neutral / P / b shapes."""
    rng = hi - lo
    ib_rng = ibh - ibl
    if rng <= 0:
        return {"type": "unknown", "note": ""}
    ext_up = max(0.0, hi - ibh) / rng
    ext_dn = max(0.0, ibl - lo) / rng
    close_loc = (c - lo) / rng  # 0 = low, 1 = high
    # volume(TPO)-weighted center: where did we spend time?
    tot = sum(counts.values()) or 1
    center = sum(p * counts[p] for p in prices) / tot
    center_loc = (center - lo) / rng

    if ext_up > 0.10 and ext_dn > 0.10:
        t = "neutral"
        note = ("Both IB extremes extended - responsive traders in control. "
                "Watch for failed auction: the side that breaks and fails fuels the other side.")
    elif ib_rng / rng < 0.35 and ((close_loc > 0.75 and ext_up > 0.3) or (close_loc < 0.25 and ext_dn > 0.3)):
        t = "trend"
        note = ("Small IB + healthy continuation = trend day. Enter on small pullbacks showing "
                "absorption; expect a more balanced day tomorrow.")
    elif center_loc > 0.62:
        t = "P-shape"
        note = ("P-shape (short-covering / liquidation up). Position near the bottom of the upper "
                "balance, target the middle or other end.")
    elif center_loc < 0.38:
        t = "b-shape"
        note = ("b-shape (long liquidation). Position near the top of the lower balance, "
                "target middle/other end.")
    elif ext_up < 0.05 and ext_dn < 0.05:
        t = "balanced"
        note = "IB held the day - rotational. Fade edges, play to the middle; breakouts need initiative volume."
    else:
        t = "normal"
        note = "One-sided range extension off the IB. Trade with the extension side while value migrates."
    return {"type": t, "note": note, "ib_pct_of_range": round(ib_rng / rng, 3),
            "close_location": round(close_loc, 3), "tpo_center_location": round(center_loc, 3)}


def failed_auction(session_df: pd.DataFrame, ibh: float, ibl: float) -> dict | None:
    """Detect a break of the IB extreme that came back inside."""
    post_ib = session_df.iloc[2:]
    if post_ib.empty:
        return None
    for side, lvl in (("high", ibh), ("low", ibl)):
        broke = False
        for _, bar in post_ib.iterrows():
            if side == "high" and bar.High > lvl:
                broke = True
            if side == "low" and bar.Low < lvl:
                broke = True
            if broke:
                back_in = bar.Close < lvl if side == "high" else bar.Close > lvl
                if back_in:
                    return {"side": side, "level": lvl,
                            "note": f"Failed auction at IB {side}: break was rejected. Liquidation of trapped "
                                    f"traders gives fuel toward the other side of the range."}
    return None


def volume_profile(symbol: str, session_df: pd.DataFrame, bins: int = 40) -> dict:
    """Volume-at-price from intraday bars + HVN/LVN detection."""
    hi, lo = float(session_df.High.max()), float(session_df.Low.min())
    if hi <= lo:
        return {"ok": False, "error": "flat session"}
    edges = np.linspace(lo, hi, bins + 1)
    vols = np.zeros(bins)
    for _, bar in session_df.iterrows():
        b_lo, b_hi, v = float(bar.Low), float(bar.High), float(bar.Volume)
        if v <= 0 or b_hi <= b_lo:
            continue
        for i in range(bins):
            ov = max(0.0, min(b_hi, edges[i + 1]) - max(b_lo, edges[i]))
            vols[i] += v * ov / (b_hi - b_lo)
    total = vols.sum() or 1.0
    poc_i = int(vols.argmax())
    # value area 70%
    va = {poc_i}; covered = vols[poc_i]
    while covered < 0.70 * total:
        lo_i, hi_i = min(va) - 1, max(va) + 1
        vl = vols[lo_i] if lo_i >= 0 else -1
        vh = vols[hi_i] if hi_i < bins else -1
        if vl < 0 and vh < 0:
            break
        if vl >= vh:
            va.add(lo_i); covered += vl
        else:
            va.add(hi_i); covered += vh
    mids = (edges[:-1] + edges[1:]) / 2
    mean_v = vols.mean()
    hvn = [round(float(mids[i]), 4) for i in range(bins) if vols[i] > 1.6 * mean_v]
    lvn = [round(float(mids[i]), 4) for i in range(1, bins - 1)
           if vols[i] < 0.45 * mean_v and vols[i] < vols[i - 1] and vols[i] < vols[i + 1]]
    return {
        "ok": True,
        "levels": [{"price": round(float(m), 4), "volume": int(v)} for m, v in zip(mids, vols)],
        "vpoc": round(float(mids[poc_i]), 4),
        "vah": round(float(mids[max(va)]), 4),
        "val": round(float(mids[min(va)]), 4),
        "hvn": hvn, "lvn": lvn,
        "note": ("HVNs = acceptance: expect a retest then continuation through if price spends time back inside. "
                 "LVNs = rejection edges: use as S/R in balance, and as acceleration zones once broken."),
    }


def session_profile(symbol: str, day: str | None = None) -> dict:
    """Full profile pack for one RTH session (default: latest)."""
    try:
        df30 = md.get_history(symbol, "1mo", "30m")
        df5 = md.get_history(symbol, "5d", "5m")
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}
    sessions = md.rth_sessions(df30)
    if not sessions:
        return {"ok": False, "error": "no RTH sessions in data"}
    days = sorted(sessions.keys())
    day = day if day in sessions else days[-1]
    tpo = build_tpo(symbol, sessions[day])
    vp_sessions = md.rth_sessions(df5)
    vp = volume_profile(symbol, vp_sessions[day]) if day in vp_sessions else {"ok": False, "error": "no 5m data"}
    prior = days[days.index(day) - 1] if days.index(day) > 0 else None
    prior_tpo = build_tpo(symbol, sessions[prior]) if prior else None
    return {"ok": True, "day": day, "available_days": days[-10:], "tpo": tpo,
            "volume_profile": vp, "prior_day": prior, "prior_tpo": prior_tpo}
