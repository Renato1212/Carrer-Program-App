"""Scheduled-news war calendar.

Rule-generated US macro schedule (NFP = first Friday, claims = Thursdays,
OPEX = 3rd Friday, etc.) plus published FOMC dates, each with an event-specific
trading playbook. Dates that follow a typical-but-unofficial pattern are
flagged `approx` so the trader verifies against the BLS/BEA release pages.
"""
from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from backend.services.fedwatch import FOMC_DATES

ET = ZoneInfo("America/New_York")

PLAYBOOKS = {
    "FOMC": {
        "impact": "extreme", "time": "14:00 ET (presser 14:30)",
        "playbook": [
            "Run the Day 14 prep: dots vs pricing, statement language diff, what the Fed is watching.",
            "Pre-position only with conviction + defined risk; otherwise flat into 14:00 (Day 1: uncertain = don't trade).",
            "First spike often reverses - the presser sets the real direction. Trade the SECOND move.",
            "Pre-map reaction levels: prior VAH/VAL, ON extremes - news moves respect structure (Day 2).",
        ],
    },
    "NFP": {
        "impact": "extreme", "time": "08:30 ET",
        "playbook": [
            "Know consensus AND the whisper. The trade is the surprise, including revisions + AHE.",
            "Conflicting internals (strong jobs, soft wages) = chop. Clean surprise = momentum: join pullbacks showing absorption (Day 10).",
            "8:30 prints set the overnight breakout or failure - have both scenarios mapped.",
        ],
    },
    "CPI": {
        "impact": "extreme", "time": "08:30 ET",
        "playbook": [
            "Core MoM is the number. 0.1 off consensus = full regime move in ES/NQ/ZN.",
            "Check ES/ZN correlation regime first - it tells you which direction a hot print hits equities.",
            "Fade extended first moves only at HTF levels with order-flow confirmation (Day 2/10).",
        ],
    },
    "PPI": {"impact": "high", "time": "08:30 ET",
            "playbook": ["Pipeline inflation - matters most right after a surprising CPI.",
                          "Components feed PCE: a hot PCE-relevant PPI can move rates harder than headline."]},
    "PCE": {"impact": "high", "time": "08:30 ET",
            "playbook": ["The Fed's preferred gauge. Usually well-forecast after CPI/PPI - muted unless surprise.",
                          "Month-end Friday release: combines with rebalancing flows - expect odd tape."]},
    "Retail Sales": {"impact": "high", "time": "08:30 ET",
                     "playbook": ["Consumer = 70% of GDP. Control group is the signal.",
                                   "Growth-scare regimes flip the reaction function: bad news = bad."]},
    "GDP": {"impact": "medium", "time": "08:30 ET",
            "playbook": ["Backward-looking; advance print moves markets, revisions rarely do."]},
    "Jobless Claims": {"impact": "medium", "time": "08:30 ET",
                       "playbook": ["Weekly labor pulse. Matters 10x more when labor is the Fed's focus.",
                                     "A >20k surprise can set the 8:30 tone on otherwise quiet Thursdays."]},
    "ISM Manufacturing": {"impact": "high", "time": "10:00 ET",
                          "playbook": ["10:00 ET = second intraday volatility window after the open.",
                                        "Prices-paid sub-index can out-move the headline in inflation regimes."]},
    "ISM Services": {"impact": "high", "time": "10:00 ET",
                     "playbook": ["Services = sticky inflation. Watch employment + prices components."]},
    "Michigan Sentiment": {"impact": "medium", "time": "10:00 ET",
                           "playbook": ["Inflation-expectations component is what the Fed quotes."]},
    "Treasury Auction (10Y/30Y)": {"impact": "medium", "time": "13:00 ET",
                                   "playbook": ["Tails/stop-throughs move ZN/ZB instantly, equities second.",
                                                 "13:00 ET - prime time for an afternoon trend ignition or failure."]},
    "OPEX": {"impact": "high", "time": "all session",
             "playbook": ["Monthly options expiration - pinning near big OI strikes, then post-OPEX freedom.",
                           "Check the GEX map: positive gamma = mean reversion day; flip level = the battlefield."]},
    "Quad Witching": {"impact": "high", "time": "all session + close",
                      "playbook": ["Index futures+options expire together: giant volumes at open/close auctions.",
                                    "Roll volume distorts volume signals - use relative volume vs other quad days."]},
    "VIX Expiration": {"impact": "medium", "time": "09:30 ET settle",
                       "playbook": ["Wednesday AM VIX settle can release/spark vol around the open."]},
    "EIA Crude Inventories": {"impact": "high", "time": "10:30 ET Wed",
                              "playbook": ["CL's weekly main event. Surprise draw/build = instant momentum burst.",
                                            "Trade the level it happens AT, not just the number (Day 2)."]},
}


def _nth_weekday(year, month, weekday, n) -> date:
    d = date(year, month, 1)
    offset = (weekday - d.weekday()) % 7
    return d + timedelta(days=offset + 7 * (n - 1))


def _all_weekdays(year, month, weekday):
    d = date(year, month, 1)
    offset = (weekday - d.weekday()) % 7
    d += timedelta(days=offset)
    while d.month == month:
        yield d
        d += timedelta(days=7)


def build_calendar(start: date, end: date) -> list[dict]:
    events = []

    def add(d, name, approx=False):
        if start <= d <= end:
            pb = PLAYBOOKS.get(name, {})
            events.append({"date": d.isoformat(), "event": name,
                           "impact": pb.get("impact", "medium"),
                           "time": pb.get("time", ""), "approx": approx,
                           "playbook": pb.get("playbook", [])})

    months = set()
    d = start.replace(day=1)
    while d <= end:
        months.add((d.year, d.month))
        d = (d.replace(day=28) + timedelta(days=7)).replace(day=1)

    for (y, m) in sorted(months):
        add(_nth_weekday(y, m, 4, 1), "NFP")                       # first Friday
        for th in _all_weekdays(y, m, 3):
            add(th, "Jobless Claims")
        for we in _all_weekdays(y, m, 2):
            add(we, "EIA Crude Inventories")
        add(_nth_weekday(y, m, 1, 2), "CPI", approx=True)          # ~2nd Tue (verify BLS)
        add(_nth_weekday(y, m, 3, 2), "PPI", approx=True)
        add(_nth_weekday(y, m, 1, 3) + timedelta(days=1), "Retail Sales", approx=True)
        add(_nth_weekday(y, m, 4, 4), "PCE", approx=True)          # ~last Friday
        add(_nth_weekday(y, m, 4, 3), "Quad Witching" if m in (3, 6, 9, 12) else "OPEX")
        add(_nth_weekday(y, m, 2, 3), "VIX Expiration", approx=True)
        first_bd = next(dd for dd in (date(y, m, 1) + timedelta(days=i) for i in range(7)) if dd.weekday() < 5)
        add(first_bd, "ISM Manufacturing", approx=True)
        add(first_bd + timedelta(days=2), "ISM Services", approx=True)
        add(_nth_weekday(y, m, 4, 2), "Michigan Sentiment", approx=True)
        add(_nth_weekday(y, m, 2, 2), "Treasury Auction (10Y/30Y)", approx=True)
        if m in (1, 4, 7, 10):
            add(_nth_weekday(y, m, 3, 4), "GDP", approx=True)

    for f in FOMC_DATES:
        if start <= f <= end:
            pb = PLAYBOOKS["FOMC"]
            events.append({"date": f.isoformat(), "event": "FOMC Decision",
                           "impact": pb["impact"], "time": pb["time"],
                           "approx": False, "playbook": pb["playbook"]})

    events.sort(key=lambda e: (e["date"], e["time"]))
    return events


def upcoming(days_ahead: int = 21) -> dict:
    today = datetime.now(ET).date()
    evs = build_calendar(today, today + timedelta(days=days_ahead))
    for e in evs:
        e["days_until"] = (date.fromisoformat(e["date"]) - today).days
    nxt = next((e for e in evs if e["impact"] == "extreme"), None)
    return {
        "ok": True, "today": today.isoformat(), "events": evs, "next_major": nxt,
        "disclaimer": ("Events marked ~ are rule-generated from the typical release pattern - confirm "
                       "exact dates on bls.gov / bea.gov / federalreserve.gov calendars."),
    }
