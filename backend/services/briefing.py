"""Pre-market briefing generator: fuses calendar, levels, profile, flow,
rates and news into the single page a futures day trader reads before the
bell - the Day 8 prep routine, automated.
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from backend.services import econ_calendar, fedwatch, flow, levels, news as news_svc
from backend.services import market_data as md
from backend.services import predictions

ET = ZoneInfo("America/New_York")


def _suggest_setups(lv: dict, gex: dict) -> list[dict]:
    """Map current context to the most relevant program setups."""
    out = []
    if not lv.get("ok"):
        return out
    zone = lv["opening"]["zone"]
    pdt = lv.get("prior_day_type", {}).get("type")
    if "gap" in zone:
        if "just outside" in lv["opening"]["bias"]:
            out.append({"id": "open-drive-gap", "reason": "Open is gapping just outside prior range."})
        else:
            out.append({"id": "fade-extended-gap", "reason": "Open is gapping far from prior range."})
    if "inside prior value" in zone:
        out.append({"id": "value-traversal", "reason": "Opening inside prior value - rotational expectations."})
    if "outside value, inside range" in zone:
        out.append({"id": "prior-value-rejection", "reason": "First test of prior value is the key decision."})
    if pdt in ("neutral", "balanced"):
        out.append({"id": "failed-auction", "reason": f"Prior day was {pdt} - failed auctions off the range edges are top-tier."})
    if pdt == "trend":
        out.append({"id": "liquidation-balance", "reason": "Day after a trend day usually balances (Day 7)."})
    tpo_flags = [l for l in lv.get("levels", []) if "Poor" in (l.get("note") or "")]
    if tpo_flags:
        out.append({"id": "poor-high-magnet", "reason": f"Unfinished auction at {tpo_flags[0]['name']} {tpo_flags[0]['price']}."})
    if gex.get("ok") and gex.get("regime") == "negative":
        out.append({"id": "trend-pullback", "reason": "Negative dealer gamma - moves extend; momentum playbook favored."})
    if gex.get("ok") and gex.get("regime") == "positive":
        out.append({"id": "stop-catch", "reason": "Positive gamma pinning - failed breakouts & stop-run snaps more likely."})
    return out[:5]


def premarket_briefing(symbol: str = "ES") -> dict:
    now = datetime.now(ET)
    cal = econ_calendar.upcoming(days_ahead=3)
    today_events = [e for e in cal["events"] if e["days_until"] == 0]
    lv = levels.key_levels(symbol)
    fw = fedwatch.meeting_probabilities()
    gx = flow.gex_profile(symbol)
    nw = news_svc.get_news()
    quote = md.get_quote(symbol)
    vix = md.get_quote("VIX")

    warnings = []
    for e in today_events:
        if e["impact"] in ("extreme", "high"):
            warnings.append(f"{e['event']} at {e['time']} today - plan scenarios beforehand, size down or stand aside into the print (Day 1).")
    if nw.get("ok"):
        for a in nw["alerts"][:3]:
            if symbol in a["impacts"] or a["tier"] == "critical":
                warnings.append(f"[{a['tier'].upper()}] {a['title']} ({a['source']})")
    if vix.get("ok") and vix.get("last"):
        v = vix["last"]
        regime = "low-vol grind" if v < 15 else "normal" if v < 22 else "elevated" if v < 30 else "crisis"
        warnings.append(f"VIX {v:.1f} ({regime}) - calibrate stop distance and size to this regime.")
    warnings.extend(predictions.top_swings_for_briefing())

    return {
        "ok": True,
        "generated": now.isoformat(timespec="minutes"),
        "symbol": symbol,
        "quote": quote,
        "session_warnings": warnings,
        "today_events": today_events,
        "next_major_event": cal.get("next_major"),
        "opening_context": lv.get("opening") if lv.get("ok") else None,
        "prior_day_type": lv.get("prior_day_type") if lv.get("ok") else None,
        "key_levels": [l for l in lv.get("levels", []) if abs(l.get("distance") or 0) > 0][:14] if lv.get("ok") else [],
        "levels_error": None if lv.get("ok") else lv.get("error"),
        "rates": {
            "implied_path": fw.get("meetings", [])[:2],
            "current_rate": fw.get("current_implied_rate"),
        },
        "gamma": {k: gx.get(k) for k in ("ok", "regime", "zero_gamma", "max_pain_front",
                                          "put_call_oi_ratio", "spot", "read", "error")},
        "suggested_setups": _suggest_setups(lv, gx),
        "checklist": [
            "How did the market trade yesterday and where did it close? (auto-read above)",
            "Where are we opening relative to prior value and range? (auto-read above)",
            "What's on the calendar today, and what's priced in? (auto-read above)",
            "Mark your levels BEFORE the open; note which are first touches (Day 2).",
            "Watch the Initial Balance for directional conviction - lean with it (Day 8).",
            "Define: what am I hunting today, and what makes me stand aside?",
        ],
    }
