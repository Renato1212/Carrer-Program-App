"""Key levels engine + opening context.

Automates the Day 8 pre-open routine: where did we close, where did we open
relative to prior value/range, how is the overnight session shaping up, and
what does the gap (if any) suggest.
Tracks 'first touch' freshness per Day 2 (prioritize first touches).
"""
from __future__ import annotations

from datetime import datetime, time as dtime
from zoneinfo import ZoneInfo

import pandas as pd

from backend.cache import ttl_cache
from backend.services import market_data as md
from backend.services import profile as prof

ET = ZoneInfo("America/New_York")


def _touched(df, level: float) -> int:
    """How many bars have traded through a level (0 = untested/first touch pending)."""
    if level is None:
        return 0
    return int(((df.Low <= level) & (df.High >= level)).sum())


@ttl_cache(seconds=45)
def key_levels(symbol: str) -> dict:
    """All structural levels a futures day trader preps before the bell."""
    try:
        df30 = md.get_history(symbol, "1mo", "30m")
        df5 = md.get_history(symbol, "5d", "5m")
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}

    sessions = md.rth_sessions(df30)
    days = sorted(sessions.keys())
    if not days:
        return {"ok": False, "error": "no sessions"}

    now = datetime.now(ET)
    today_str = str(now.date())
    # If today's RTH exists it's the live session; prior day is the last completed one.
    if today_str in days and len(days) >= 2:
        cur_day, prior_day = today_str, days[days.index(today_str) - 1]
    else:
        cur_day, prior_day = None, days[-1]

    p = sessions[prior_day]
    prior_tpo = prof.build_tpo(symbol, p)
    pdh, pdl, pdc = float(p.High.max()), float(p.Low.min()), float(p.iloc[-1].Close)

    # Overnight (Globex) range for the upcoming/current session
    on_df = md.overnight_session(df5, now.date())
    on_high = float(on_df.High.max()) if not on_df.empty else None
    on_low = float(on_df.Low.min()) if not on_df.empty else None

    # Weekly refs (DataFrame.last() was removed in pandas 3 - filter by index)
    wk = df30[df30.index >= df30.index.max() - pd.Timedelta(days=7)]
    week_high, week_low = float(wk.High.max()), float(wk.Low.min())

    last = float(df5.iloc[-1].Close)
    recent = df5[df5.index >= df5.index.max() - pd.Timedelta(days=2)]

    levels = []

    def add(name, price, kind, note=""):
        if price is None:
            return
        touches = _touched(recent, price)
        levels.append({
            "name": name, "price": round(float(price), 4), "kind": kind,
            "touches_2d": touches,
            "fresh": touches <= 1,
            "distance": round(last - float(price), 4),
            "note": note,
        })

    add("Prior Day High", pdh, "structure", "Poor high behind it" if prior_tpo["poor_high"] else "")
    add("Prior Day Low", pdl, "structure", "Poor low behind it" if prior_tpo["poor_low"] else "")
    add("Prior Day Close", pdc, "structure")
    add("Prior VAH", prior_tpo["vah"], "value", "First rejection of prior value is tradeable")
    add("Prior VAL", prior_tpo["val"], "value", "First rejection of prior value is tradeable")
    add("Prior POC", prior_tpo["poc"], "value", "Acceptance magnet - markets often retest before continuing")
    add("Prior IB High", prior_tpo["ib_high"], "structure")
    add("Prior IB Low", prior_tpo["ib_low"], "structure")
    add("Overnight High", on_high, "overnight", "Globex extreme - stops cluster behind it")
    add("Overnight Low", on_low, "overnight", "Globex extreme - stops cluster behind it")
    add("Week High", week_high, "htf", "Higher timeframe level - more traders see it")
    add("Week Low", week_low, "htf", "Higher timeframe level - more traders see it")
    for s in prior_tpo["single_prints"][:5]:
        add("Single Print", s, "single", "Low-time acceptance - acceleration zone if revisited")

    levels.sort(key=lambda x: -x["price"])

    opening = opening_context(last, prior_tpo, pdh, pdl, pdc, on_high, on_low, cur_day, sessions)

    return {
        "ok": True, "symbol": symbol, "last": last,
        "prior_day": prior_day, "live_session": cur_day,
        "levels": levels, "opening": opening,
        "prior_day_type": prior_tpo["day_type"],
    }


def opening_context(last, prior_tpo, pdh, pdl, pdc, on_high, on_low, cur_day, sessions) -> dict:
    """Day 8 decision tree: open vs prior value & range -> expectations + gap read."""
    vah, val = prior_tpo["vah"], prior_tpo["val"]
    rng = pdh - pdl if pdh and pdl else 0

    open_price = None
    if cur_day and cur_day in sessions:
        open_price = float(sessions[cur_day].iloc[0].Open)
    ref = open_price if open_price is not None else last
    src = "RTH open" if open_price is not None else "current price (pre-open projection)"

    if val <= ref <= vah:
        zone = "inside prior value"
        bias = ("Acceptance - expect rotation inside value. Lower conviction day: fade value edges, "
                "play to the POC. Breakouts need clear initiative activity to trust.")
    elif pdl <= ref <= pdh:
        zone = "outside value, inside range"
        bias = ("Mild imbalance. Watch the first test of prior value: first rejection = trade away from value; "
                "acceptance back inside = rotation through value to the other side.")
    else:
        zone = "outside prior range (gap)"
        gap_size = abs(ref - pdc)
        gap_atr = gap_size / rng if rng else 0
        if gap_atr < 0.35:
            bias = ("Gap just outside the range: best breakout entry is right at the open - trapped traders "
                    "exit while breakout buyers/sellers chase. Failure back inside the range = "
                    "look-above/below-and-fail rotation.")
        else:
            bias = ("Extended gap far from the range: positioned winners take profits at the open while "
                    "responsive traders fade the extension - especially near a strong HTF zone. "
                    "Let the first minutes show who's in control before committing.")
        zone += f" ({'+' if ref > pdc else '-'}{round(gap_size, 2)} vs prior close, {round(gap_atr * 100)}% of prior range)"

    on_note = ""
    if on_high and on_low and ref:
        if ref > on_high * 0.999 and ref > pdh:
            on_note = "Trading above both overnight high and prior range - overnight shorts are trapped fuel."
        elif ref < on_low * 1.001 and ref < pdl:
            on_note = "Trading below both overnight low and prior range - overnight longs are trapped fuel."

    return {"reference": round(ref, 4), "reference_source": src, "zone": zone, "bias": bias,
            "overnight_note": on_note,
            "first_hour_rule": ("Read the Initial Balance for directional conviction - unless something changes, "
                                "lean with that direction for the session.")}
