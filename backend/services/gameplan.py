"""The Game Plan engine - turns every module's output into ONE organized,
actionable plan for the session.

Core idea: a level means little alone; levels CONFLUENT with each other -
prior value + naked POC + gamma strike + overnight extreme stacking in one
zone - mean everything. We cluster all levels into zones, grade the
confluence, explain what's stacked there, and derive concrete if/then trade
ideas with invalidation and the next zone as target.
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from backend.cache import ttl_cache
from backend.services import briefing, composite

ET = ZoneInfo("America/New_York")

# weight per evidence type when grading a zone
WEIGHTS = {
    "Week High": 3.0, "Week Low": 3.0,
    "Composite POC": 3.0, "Composite VAH": 2.5, "Composite VAL": 2.5,
    "Naked POC": 2.5, "Unfilled Gap": 2.0, "Poor High": 2.0, "Poor Low": 2.0,
    "Prior Day High": 2.0, "Prior Day Low": 2.0,
    "Prior VAH": 2.0, "Prior VAL": 2.0, "Prior POC": 2.0,
    "Zero-Gamma Flip": 2.0, "Max Pain": 1.5,
    "Overnight High": 1.5, "Overnight Low": 1.5,
    "Prior IB High": 1.0, "Prior IB Low": 1.0,
    "Composite HVN": 1.5, "Composite LVN": 1.2,
    "Single Print": 1.0, "Prior Day Close": 1.0,
}


def _grade(score: float) -> str:
    return "A+" if score >= 6 else "A" if score >= 4.5 else "B" if score >= 3 else "C"


def _zone_action(parts: list[dict], side: str) -> str:
    names = {p["name"] for p in parts}
    bits = []
    fresh = any(p.get("fresh") for p in parts)
    if names & {"Naked POC", "Unfilled Gap"}:
        bits.append("magnet zone - unfinished business pulls price here")
    if names & {"Poor High", "Poor Low"}:
        bits.append("unfinished auction: expect stops beyond it - breakout fuel / stop-run snap risk")
    if names & {"Composite LVN", "Single Print"}:
        bits.append("thin acceptance behind it - a clean break accelerates to the next fat zone")
    if names & {"Composite POC", "Composite HVN"}:
        bits.append("heavy acceptance - expect price to slow and rotate here; good profit-taking area")
    if names & {"Prior VAH", "Prior VAL", "Composite VAH", "Composite VAL"}:
        bits.append(("FIRST touch of value edge - fade candidate with order-flow confirmation"
                     if fresh else "tested value edge - weakening reactions favor the break"))
    if "Zero-Gamma Flip" in names:
        bits.append("gamma regime flips through here - expect volatility character to change")
    if names & {"Overnight High", "Overnight Low"}:
        bits.append("overnight extreme - trapped Globex traders defend/bail here")
    if not bits:
        bits.append("structural reference - watch the reaction, trade the confirmation not the touch")
    verb = "Above" if side == "above" else "Below"
    return f"{verb} current price. " + "; ".join(bits[:3]).capitalize() + "."


@ttl_cache(seconds=45)
def build(symbol: str = "ES") -> dict:
    b = briefing.premarket_briefing(symbol)
    try:
        comp = composite.composite_pack(symbol, days=10)
    except Exception as e:
        comp = {"ok": False, "error": str(e)[:200]}

    last = (b.get("quote") or {}).get("last") or (comp.get("last") if comp.get("ok") else None)
    if last is None:
        return {"ok": False, "error": "no price data available right now - retry shortly",
                "briefing": b}

    # ---- gather every level from every module ----
    raw: list[dict] = []
    for l in b.get("key_levels") or []:
        raw.append({"name": l["name"], "price": l["price"], "fresh": l.get("fresh")})
    if comp.get("ok"):
        c = comp["composite"]
        raw += [{"name": "Composite POC", "price": c["poc"]},
                {"name": "Composite VAH", "price": c["vah"]},
                {"name": "Composite VAL", "price": c["val"]}]
        raw += [{"name": "Composite HVN", "price": p} for p in c["hvn"][:4]]
        raw += [{"name": "Composite LVN", "price": p} for p in c["lvn"][:4]]
        raw += [{"name": "Naked POC", "price": n["price"]} for n in comp["naked_pocs"]]
        raw += [{"name": "Unfilled Gap", "price": g["from"]} for g in comp["unfilled_gaps"]]
        raw += [{"name": p["kind"].title(), "price": p["price"]} for p in comp["untested_extremes"]]
    g = b.get("gamma") or {}
    if g.get("ok") and g.get("spot"):
        factor = last / g["spot"]
        if g.get("zero_gamma"):
            raw.append({"name": "Zero-Gamma Flip", "price": round(g["zero_gamma"] * factor, 2)})
        if g.get("max_pain_front"):
            raw.append({"name": "Max Pain", "price": round(g["max_pain_front"] * factor, 2)})

    # ---- cluster into zones ----
    tol = max(0.0012 * last, 1e-9)
    raw = [r for r in raw if r.get("price")]
    raw.sort(key=lambda r: r["price"])
    zones: list[dict] = []
    for r in raw:
        # merge only if close to the zone edge AND the zone stays tight (max ~3*tol wide)
        if zones and r["price"] - zones[-1]["hi"] <= tol and r["price"] - zones[-1]["lo"] <= 3 * tol:
            z = zones[-1]
            z["hi"] = max(z["hi"], r["price"])
            z["parts"].append(r)
        else:
            zones.append({"lo": r["price"], "hi": r["price"], "parts": [r]})
    for z in zones:
        z["lo"], z["hi"] = round(z["lo"], 4), round(z["hi"], 4)
        z["score"] = round(sum(WEIGHTS.get(p["name"], 1.0) + (0.5 if p.get("fresh") else 0)
                               for p in z["parts"]), 1)
        z["grade"] = _grade(z["score"])
        z["mid"] = round((z["lo"] + z["hi"]) / 2, 4)
        z["side"] = "above" if z["mid"] >= last else "below"
        z["action"] = _zone_action(z["parts"], z["side"])
        z["labels"] = sorted({p["name"] for p in z["parts"]})
    zones.sort(key=lambda z: z["mid"], reverse=True)
    above = [z for z in zones if z["side"] == "above"][-4:]          # nearest 4 above
    below = [z for z in zones if z["side"] == "below"][:4]           # nearest 4 below

    # ---- trade ideas: nearest strong zones, target = next zone past it ----
    ideas = []
    def idea(zlist, idx, direction_into, side_word):
        if idx >= len(zlist):
            return
        z = zlist[idx]
        nxt = zlist[idx + 1] if idx + 1 < len(zlist) else None
        if z["grade"] in ("A+", "A", "B"):
            risk = round(abs(z["hi"] - z["lo"]) + tol, 4)
            fade_target = round(last, 4)
            ideas.append({
                "zone": f"{z['lo']:g} – {z['hi']:g}", "grade": z["grade"],
                "what": f"{'Fade' if z['grade'] in ('A+','A') else 'React at'} the {side_word} zone "
                        f"({', '.join(z['labels'][:3])})",
                "plan_fade": f"First touch + responsive order flow -> {('short' if side_word=='upper' else 'long')} "
                             f"against {z['hi' if side_word=='upper' else 'lo']:g}, stop ~{risk:g} beyond the zone, "
                             f"first target back to {fade_target:g}.",
                "plan_break": (f"Acceptance beyond it (time + initiative volume) -> "
                               f"{'long' if side_word=='upper' else 'short'} continuation toward "
                               f"{nxt['mid']:g} ({nxt['grade']}: {', '.join(nxt['labels'][:2])})."
                               if nxt else "No mapped zone beyond - if it accepts, trail with structure."),
            })
    # nearest above = last element of `above`; iterate from nearest outward
    above_near_first = list(reversed(above))
    idea(above_near_first, 0, "short", "upper")
    idea(below, 0, "long", "lower")

    # ---- the story ----
    story = []
    if comp.get("ok"):
        vt = comp["value_trend"]
        story.append(vt["note"])
        c = comp["composite"]
        if last > c["vah"]:
            story.append(f"Price trades ABOVE the {comp['days_used']}-day composite value ({c['val']:g}-{c['vah']:g}). "
                         "Acceptance up here is bullish; a quick rejection back inside targets the composite POC "
                         f"at {c['poc']:g} (look-above-and-fail).")
        elif last < c["val"]:
            story.append(f"Price trades BELOW the {comp['days_used']}-day composite value ({c['val']:g}-{c['vah']:g}). "
                         "Acceptance down here is bearish; a quick reclaim targets the composite POC "
                         f"at {c['poc']:g}.")
        else:
            story.append(f"Price is INSIDE the {comp['days_used']}-day composite value ({c['val']:g}-{c['vah']:g}) - "
                         f"rotation environment around the composite POC {c['poc']:g} until value breaks.")
        if comp["naked_pocs"]:
            n = comp["naked_pocs"][0]
            story.append(f"Nearest unfinished business: naked POC at {n['price']:g} from {n['day']} "
                         f"({'above' if n['distance']<0 else 'below'}, {abs(n['distance']):g} away) - a live magnet.")
    pdt = b.get("prior_day_type") or {}
    if pdt.get("type"):
        story.append(f"Yesterday was a {pdt['type']} day. {pdt.get('note','')}")
    oc = b.get("opening_context") or {}
    if oc.get("zone"):
        story.append(f"Opening read: {oc['zone']}. {oc.get('bias','')}")
    if g.get("ok"):
        story.append(f"Dealer gamma is {g['regime'].upper()} (flip ~{g.get('zero_gamma')}, proxy). {g.get('read','')}")
    for e in b.get("today_events") or []:
        if e["impact"] in ("extreme", "high"):
            story.append(f"RISK SCHEDULE: {e['event']} at {e['time']} today - plan your flat/size-down window "
                         "around it; the best trades often come from the post-print repricing, not the guess.")

    # ---- do / don't ----
    do, dont = [], []
    if comp.get("ok"):
        d = comp["value_trend"]["direction"]
        if d == "up":
            do.append("Hunt longs at the lower zones / first pullbacks into prior value.")
            dont.append("Don't short value-edge touches just because price 'looks high' - value is migrating up.")
        elif d == "down":
            do.append("Hunt shorts at the upper zones / first rallies into prior value.")
            dont.append("Don't knife-catch at lower zones without responsive order flow.")
        else:
            do.append("Trade the edges of the composite value back to its middle until a real break.")
            dont.append("Don't chase mid-range breakouts in a balancing market - that's where stops feed the range.")
    if g.get("ok") and g.get("regime") == "positive":
        dont.append("Positive gamma: don't expect runners - take rotational profits at the next zone.")
    if g.get("ok") and g.get("regime") == "negative":
        do.append("Negative gamma: momentum extends - let a core run with a structure trail.")
    if any(e["impact"] == "extreme" for e in b.get("today_events") or []):
        dont.append("Don't carry size into the release.")
    do.append("Mark the first touch of each A-zone - first touches get the cleanest reactions.")

    return {
        "ok": True, "symbol": symbol, "generated": datetime.now(ET).isoformat(timespec="minutes"),
        "last": last,
        "quote": b.get("quote"),
        "story": [s for s in story if s][:8],
        "zones_above": list(reversed(above)),   # nearest first
        "zones_below": below,                   # nearest first
        "ideas": ideas,
        "do": do[:4], "dont": dont[:4],
        "warnings": b.get("session_warnings") or [],
        "today_events": b.get("today_events") or [],
        "next_major_event": b.get("next_major_event"),
        "checklist": b.get("checklist") or [],
        "suggested_setups": b.get("suggested_setups") or [],
        "composite_ok": comp.get("ok", False),
        "composite_error": comp.get("error"),
        "rates": b.get("rates"),
        "gamma": g,
    }
