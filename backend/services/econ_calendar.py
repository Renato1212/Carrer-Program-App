"""Economic calendar with real data values.

Primary source: FairEconomy (ForexFactory) weekly JSON - free, no key. Gives
exact release datetimes, impact, FORECAST and PREVIOUS for every event.
Secondary: BLS public API v1 (no key) for the latest actual US headline prints.
Fallback: rule-generated schedule when feeds are unreachable.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx

from backend.cache import ttl_cache
from backend.services.fedwatch import FOMC_DATES

ET = ZoneInfo("America/New_York")

FF_URLS = [
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
]
BLS_URL = "https://api.bls.gov/publicAPI/v1/timeseries/data/"
BLS_SERIES = {
    "CUUR0000SA0": "CPI (all items)",
    "CUUR0000SA0L1E": "Core CPI",
    "CES0000000001": "Nonfarm Payrolls",
    "LNS14000000": "Unemployment Rate",
}

# Event guides: what the number is and how futures usually react.
EVENT_GUIDES = {
    "fomc": {"impact": "extreme", "guide": (
        "The Fed's rate decision (2:00pm ET) and press conference (2:30pm). The market trades the GAP "
        "between what was priced in beforehand and what is delivered. The first spike after the statement "
        "frequently reverses once the press conference starts - the second move is usually the honest one.")},
    "cpi": {"impact": "extreme", "guide": (
        "Consumer inflation, 8:30am ET. Core MoM is the number that moves markets: 0.1% above or below "
        "consensus can reprice the entire rate path. Hot print usually = yields up; equities' reaction "
        "depends on the current regime (check the correlations panel).")},
    "non-farm": {"impact": "extreme", "guide": (
        "The monthly US jobs report, 8:30am ET. Three numbers at once: payrolls vs forecast, revisions to "
        "prior months, and average hourly earnings. Clean surprises produce momentum; conflicting "
        "internals (strong jobs / soft wages) usually produce chop.")},
    "ppi": {"impact": "high", "guide": "Producer prices - pipeline inflation. Matters most right after a surprising CPI, since components feed the Fed's preferred PCE gauge."},
    "pce": {"impact": "high", "guide": "The Fed's preferred inflation gauge. Usually well-forecast once CPI/PPI are out, so surprises are rare but potent."},
    "retail sales": {"impact": "high", "guide": "The consumer is ~70% of US GDP. The 'control group' line feeds GDP directly and is the real signal."},
    "gdp": {"impact": "medium", "guide": "Backward-looking. The advance estimate can move markets; later revisions rarely do."},
    "unemployment claims": {"impact": "medium", "guide": "Weekly labor pulse, Thursdays 8:30am ET. A >20k surprise sets the morning tone, especially when the Fed is focused on the job market."},
    "ism": {"impact": "high", "guide": "Survey of purchasing managers, 10:00am ET - the second volatility window of the morning. Above 50 = expansion. The 'prices paid' sub-index can out-move the headline."},
    "consumer sentiment": {"impact": "medium", "guide": "University of Michigan survey. The inflation-expectations component is what the Fed quotes."},
    "crude oil inventories": {"impact": "high", "guide": "Weekly EIA stockpiles, 10:30am ET Wednesday - crude oil's main scheduled event. Surprise draw = bullish, surprise build = bearish, but the reaction at a key level matters more than the number."},
    "fed chair": {"impact": "high", "guide": "Chair speeches can reprice the rate path mid-meeting-cycle. Markets parse every deviation from the last statement."},
    "treasury": {"impact": "medium", "guide": "Auction results at 1:00pm ET. Weak demand (a 'tail') hits bonds instantly and equities second."},
}


def _guide_for(title: str) -> dict:
    t = title.lower()
    for key, g in EVENT_GUIDES.items():
        if key in t:
            return g
    return {}


@ttl_cache(seconds=900)
def _faireconomy() -> list[dict]:
    events = []
    with httpx.Client(timeout=10, headers={"User-Agent": "Mozilla/5.0 (EdgeDesk)"}) as client:
        for url in FF_URLS:
            try:
                r = client.get(url)
                r.raise_for_status()
                events.extend(r.json())
            except Exception:
                continue
    out = []
    for e in events:
        try:
            dt = datetime.fromisoformat(e["date"])
        except (KeyError, ValueError):
            continue
        title = e.get("title", "")
        guide = _guide_for(title)
        out.append({
            "datetime": dt.astimezone(ET).isoformat(),
            "date": dt.astimezone(ET).date().isoformat(),
            "time": dt.astimezone(ET).strftime("%H:%M ET"),
            "event": title,
            "country": e.get("country", ""),
            "impact": (e.get("impact") or "Low").lower(),
            "forecast": e.get("forecast") or "",
            "previous": e.get("previous") or "",
            "actual": e.get("actual") or "",
            "guide": guide.get("guide", ""),
            "source": "faireconomy",
        })
    out.sort(key=lambda x: x["datetime"])
    return out


@ttl_cache(seconds=3600)
def latest_us_prints() -> list[dict]:
    """Most recent actual values for headline US series via the keyless BLS API."""
    try:
        with httpx.Client(timeout=12) as client:
            r = client.post(BLS_URL, json={"seriesid": list(BLS_SERIES)},
                            headers={"Content-Type": "application/json"})
            r.raise_for_status()
            data = r.json()
        out = []
        for s in data.get("Results", {}).get("series", []):
            sid = s.get("seriesID")
            rows = [x for x in s.get("data", []) if x.get("period", "").startswith("M")]
            if len(rows) < 13:
                continue
            latest, prior, yago = rows[0], rows[1], rows[12]
            name = BLS_SERIES.get(sid, sid)
            v, vp, vy = float(latest["value"]), float(prior["value"]), float(yago["value"])
            item = {"name": name, "period": f"{latest['periodName']} {latest['year']}"}
            if sid.startswith("CUUR"):
                item["value"] = f"{(v / vy - 1) * 100:.1f}% YoY"
                item["secondary"] = f"{(v / vp - 1) * 100:.2f}% MoM"
            elif sid == "CES0000000001":
                item["value"] = f"{(v - vp):+,.0f}k jobs"
                item["secondary"] = f"level {v:,.0f}k"
            else:
                item["value"] = f"{v:.1f}%"
                item["secondary"] = f"prior {vp:.1f}%"
            out.append(item)
        return out
    except Exception:
        return []


def _fallback_events(start: date, end: date) -> list[dict]:
    """Rule-generated skeleton when the live feed is unreachable."""
    evs = []
    d = start
    while d <= end:
        if d.weekday() == 4 and d.day <= 7:
            evs.append(("Non-Farm Payrolls", d, "08:30 ET", "high"))
        if d.weekday() == 3:
            evs.append(("Unemployment Claims", d, "08:30 ET", "medium"))
        if d.weekday() == 2:
            evs.append(("Crude Oil Inventories", d, "10:30 ET", "high"))
        d += timedelta(days=1)
    for f in FOMC_DATES:
        if start <= f <= end:
            evs.append(("FOMC Rate Decision", f, "14:00 ET", "extreme"))
    return [{"datetime": f"{dd.isoformat()}T00:00:00", "date": dd.isoformat(), "time": tm,
             "event": name, "country": "USD", "impact": imp, "forecast": "", "previous": "",
             "actual": "", "guide": _guide_for(name).get("guide", ""), "source": "generated"}
            for name, dd, tm, imp in sorted(evs, key=lambda x: x[1])]


def upcoming(days_ahead: int = 14, country: str = "") -> dict:
    today = datetime.now(ET).date()
    live = _faireconomy()
    if live:
        events = [e for e in live if today <= date.fromisoformat(e["date"]) <= today + timedelta(days=days_ahead)]
        if country:
            events = [e for e in events if e["country"].upper() == country.upper()]
        source = "live"
    else:
        events = _fallback_events(today, today + timedelta(days=days_ahead))
        source = "generated (live feed unreachable - times/values unavailable)"
    for e in events:
        e["days_until"] = (date.fromisoformat(e["date"]) - today).days
    # ensure FOMC decisions always carry the extreme tag
    for e in events:
        if "federal funds rate" in e["event"].lower() or "fomc" in e["event"].lower():
            e["impact"] = "extreme"
    nxt = next((e for e in events
                if e["impact"] in ("extreme", "high") and e["country"] in ("USD", "")
                and datetime.fromisoformat(e["datetime"]).timestamp() > datetime.now(ET).timestamp()), None)
    return {
        "ok": True, "today": today.isoformat(), "events": events,
        "next_major": nxt, "source": source,
        "us_prints": latest_us_prints(),
        "how_to_read": (
            "Forecast = consensus expectation; Previous = last release. Markets move on the SURPRISE "
            "(actual vs forecast), not the absolute number. Releases marked red (high/extreme) regularly "
            "move futures several points within seconds - plan position size around them."),
    }
