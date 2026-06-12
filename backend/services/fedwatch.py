"""Central-bank desk: CME FedWatch-style probabilities from 30-Day Fed Funds
futures (ZQ), yield curve snapshot, and FOMC meeting context.

ZQ settles to 100 - average daily EFFR for the contract month, so meeting-month
contracts let us back out the market-implied post-meeting rate and convert it
into hike/cut probabilities - the exact 'what is priced in' input the Day 14
central-bank prep process asks for. Free via Yahoo (ZQ contracts: ZQ<M><Y>.CBT).
"""
from __future__ import annotations

import calendar
from datetime import date, datetime
from zoneinfo import ZoneInfo

import yfinance as yf

from backend.cache import ttl_cache

ET = ZoneInfo("America/New_York")
MONTH_CODES = {1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M",
               7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z"}

# Published FOMC decision days (second day of each meeting).
FOMC_DATES = [
    date(2026, 1, 28), date(2026, 3, 18), date(2026, 4, 29), date(2026, 6, 17),
    date(2026, 7, 29), date(2026, 9, 16), date(2026, 10, 28), date(2026, 12, 9),
    date(2027, 1, 27),
]

OTHER_CB = [
    {"bank": "ECB", "cadence": "Every ~6 weeks, decisions Thursday 8:15 ET, presser 8:45 ET",
     "watch": "Deposit rate path, PEPP/QT language, Lagarde presser - moves 6E, ES correlation flips"},
    {"bank": "BoJ", "cadence": "8 meetings/yr, decision overnight ET (no fixed time!)",
     "watch": "YCC/rate normalization - violent 6J moves ripple into NQ via carry-trade unwinds"},
    {"bank": "BoE", "cadence": "8 meetings/yr, Thursday 7:00 ET",
     "watch": "Vote split matters as much as the decision"},
    {"bank": "SNB/BoC/RBA", "cadence": "Quarterly / 8x yr",
     "watch": "Surprise cuts/hikes here often front-run G3 narrative shifts"},
]


def _zq_ticker(d: date) -> str:
    return f"ZQ{MONTH_CODES[d.month]}{str(d.year)[-2:]}.CBT"


@ttl_cache(seconds=300)
def _zq_price(ticker: str):
    try:
        fi = yf.Ticker(ticker).fast_info
        p = getattr(fi, "last_price", None) or getattr(fi, "previous_close", None)
        return float(p) if p else None
    except Exception:
        return None


def _month_implied_rate(d: date):
    p = _zq_price(_zq_ticker(d))
    return round(100.0 - p, 4) if p else None


def _prev_month(d: date) -> date:
    return date(d.year - 1, 12, 1) if d.month == 1 else date(d.year, d.month - 1, 1)


def meeting_probabilities() -> dict:
    """Implied rate path + move probabilities for upcoming FOMC meetings."""
    today = datetime.now(ET).date()
    meetings = [m for m in FOMC_DATES if m >= today][:4]
    current_rate = _month_implied_rate(_prev_month(meetings[0])) if meetings else None
    results = []
    base = current_rate
    for m in meetings:
        n_days = calendar.monthrange(m.year, m.month)[1]
        avg = _month_implied_rate(date(m.year, m.month, 1))
        item = {"meeting": m.isoformat(), "days_until": (m - today).days}
        if avg is None or base is None or m.day >= n_days:
            item["ok"] = False
            item["error"] = "ZQ contract unavailable on free feed"
        else:
            # month avg = pre-meeting rate * d/N + post-meeting rate * (N-d)/N
            d = m.day
            post = (avg - base * d / n_days) * n_days / (n_days - d)
            delta_bp = (post - base) * 100
            # decompose into 25bp move probabilities around the nearest step
            import math
            steps = delta_bp / 25.0
            lo_step = math.floor(steps)
            frac = steps - lo_step
            item.update({
                "ok": True,
                "pre_meeting_rate": round(base, 3),
                "implied_post_rate": round(post, 3),
                "implied_change_bp": round(delta_bp, 1),
                "scenarios": [
                    {"move_bp": int(lo_step * 25), "prob": round((1 - frac) * 100, 1)},
                    {"move_bp": int((lo_step + 1) * 25), "prob": round(frac * 100, 1)},
                ],
            })
            base = post
        results.append(item)
    return {
        "ok": any(r.get("ok") for r in results) if results else False,
        "current_implied_rate": round(current_rate, 3) if current_rate else None,
        "meetings": results,
        "method": "Backed out of 30-Day Fed Funds futures (ZQ) the same way CME FedWatch does.",
        "playbook": [
            "Compare implied probabilities to the statement/dots: the TRADE is in the gap between what's priced and what's delivered.",
            "2:00 ET statement: first move is often the trap - the presser (2:30) drives the real auction.",
            "Watch the implied path REPRICE live: a 10bp shift in the next 2 meetings is the day's true headline.",
            "Pair with 2Y yield: equities follow the front end on CB days, not the long end.",
        ],
    }


@ttl_cache(seconds=120)
def yield_curve() -> dict:
    out = {"points": [], "ok": False}
    tenors = [("3M", "^IRX"), ("5Y", "^FVX"), ("10Y", "^TNX"), ("30Y", "^TYX")]
    for label, tk in tenors:
        try:
            fi = yf.Ticker(tk).fast_info
            y = getattr(fi, "last_price", None)
            prev = getattr(fi, "previous_close", None)
            if y:
                out["points"].append({"tenor": label, "yield": round(float(y), 3),
                                      "chg_bp": round((float(y) - float(prev)) * 100, 1) if prev else None})
        except Exception:
            continue
    out["ok"] = len(out["points"]) >= 2
    by = {p["tenor"]: p["yield"] for p in out["points"]}
    if "3M" in by and "10Y" in by:
        out["spread_3m10y_bp"] = round((by["10Y"] - by["3M"]) * 100, 1)
    return out


def central_bank_desk() -> dict:
    return {
        "fedwatch": meeting_probabilities(),
        "yield_curve": yield_curve(),
        "other_banks": OTHER_CB,
        "prep_process": {
            "title": "Central Bank Meeting Prep",
            "items": [
                "Dot plots: where is the committee's median vs market pricing?",
                "Central bank language: what changed vs last statement? (diff the statements line by line)",
                "What markets are pricing in: read the ZQ-implied path above BEFORE the event",
                "What central bankers are paying attention to right now: inflation? labor? financial stability?",
                "Define scenarios pre-event: dovish/hawkish/in-line -> planned reaction for each, or stand aside",
            ],
        },
    }
