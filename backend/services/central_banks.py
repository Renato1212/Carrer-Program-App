"""Central-bank intelligence desk: Fed, ECB, BoJ, BoE.

Data sources (all free, keyless):
- DBnomics (BIS WS_CBPOL): official policy-rate history per central bank.
- Yahoo (ZQ futures): market-implied Fed path - the FedWatch math.
- Google News + official wires: per-bank headlines, speeches, analyst takes.
- An in-process probability monitor that snapshots the implied path and raises
  alerts the moment markets reprice the next decision.
"""
from __future__ import annotations

import threading
import time
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import httpx

from backend.cache import ttl_cache
from backend.services import fedwatch
from backend.services import market_data as md
from backend.services.news import _parse_feed

ET = ZoneInfo("America/New_York")
DBNOMICS = "https://api.db.nomics.world/v22/series/BIS/WS_CBPOL/M.{code}?observations=1&format=json"

BANKS = {
    "fed": {
        "name": "Federal Reserve", "short": "Fed", "bis": "US", "currency": "USD",
        "market_lens": [("ZN", None), ("US10Y", None)],
        "fx": None,
        "news_q": '"Federal Reserve" OR Powell OR FOMC when:7d',
        "official": "https://www.federalreserve.gov/feeds/press_all.xml",
        "meetings": [d.isoformat() for d in fedwatch.FOMC_DATES], "meetings_approx": False,
        "decision_time": "14:00 ET (press conf. 14:30)",
        "watch": "The implied path below IS the market's Fed view. Trade the gap between pricing and delivery; the presser usually drives the real move.",
    },
    "ecb": {
        "name": "European Central Bank", "short": "ECB", "bis": "XM", "currency": "EUR",
        "fx": "6E",
        "news_q": 'ECB OR Lagarde "rate" when:7d',
        "official": "https://www.ecb.europa.eu/rss/press.html",
        "meetings": ["2026-02-05", "2026-03-19", "2026-04-30", "2026-06-11",
                     "2026-07-23", "2026-09-10", "2026-10-29", "2026-12-17"],
        "meetings_approx": True,
        "decision_time": "08:15 ET decision, 08:45 ET press conference",
        "watch": "Decision at 8:15 ET collides with the US pre-market - 6E moves first, ES follows if the surprise is big. The press conference Q&A is where guidance actually changes.",
    },
    "boj": {
        "name": "Bank of Japan", "short": "BoJ", "bis": "JP", "currency": "JPY",
        "fx": "6J",
        "news_q": '"Bank of Japan" OR BoJ OR Ueda when:7d',
        "official": None,
        "meetings": ["2026-01-23", "2026-03-19", "2026-04-28", "2026-06-16",
                     "2026-07-31", "2026-09-18", "2026-10-30", "2026-12-18"],
        "meetings_approx": True,
        "decision_time": "overnight ET - NO fixed time (can hit during Asia lunch)",
        "watch": "The world's carry-trade anchor. BoJ surprises unwind yen-funded positions violently: 6J spikes ripple into NQ and ES within minutes. Never carry size through a BoJ night.",
    },
    "boe": {
        "name": "Bank of England", "short": "BoE", "bis": "GB", "currency": "GBP",
        "fx": "6B=F",
        "news_q": '"Bank of England" OR Bailey MPC when:7d',
        "official": "https://www.bankofengland.co.uk/rss/news",
        "meetings": ["2026-02-05", "2026-03-19", "2026-05-07", "2026-06-18",
                     "2026-08-06", "2026-09-17", "2026-11-05", "2026-12-17"],
        "meetings_approx": True,
        "decision_time": "07:00 ET, with minutes + vote split released simultaneously",
        "watch": "The MPC vote split moves markets as much as the decision - a 5-4 says more about the path than the rate itself.",
    },
}


@ttl_cache(seconds=21600)
def policy_rate_history(bis_code: str) -> list[dict]:
    """Monthly policy rate from BIS via DBnomics - ~25 years of history."""
    with httpx.Client(timeout=12) as c:
        r = c.get(DBNOMICS.format(code=bis_code))
        r.raise_for_status()
        docs = r.json().get("series", {}).get("docs", [])
        if not docs:
            return []
        periods, values = docs[0].get("period", []), docs[0].get("value", [])
        return [{"period": p, "rate": float(v)} for p, v in zip(periods, values)
                if v is not None and str(v) != "NA"][-300:]


@ttl_cache(seconds=240)
def bank_news(bank_key: str) -> list[dict]:
    b = BANKS[bank_key]
    items = []
    with httpx.Client(timeout=8, headers={"User-Agent": "Mozilla/5.0 (EdgeDesk)"},
                      follow_redirects=True) as client:
        feeds = [("Analysts & wires", "https://news.google.com/rss/search?q="
                  + httpx.QueryParams({"q": b["news_q"]})["q"].replace(" ", "+")
                  + "&hl=en-US&gl=US&ceid=US:en")]
        if b["official"]:
            feeds.append((f"{b['short']} official", b["official"]))
        for src, url in feeds:
            try:
                r = client.get(url)
                r.raise_for_status()
                items.extend(_parse_feed(r.text, src, 1.0))
            except Exception:
                continue
    items.sort(key=lambda x: x["age_min"] if x["age_min"] is not None else 9e9)
    seen, out = set(), []
    for i in items:
        k = i["title"][:60].lower()
        if k not in seen:
            seen.add(k)
            out.append(i)
    return out[:7]


# ---------- real-time probability monitor (in-process) ----------
_monitor_lock = threading.Lock()
_monitor_hist: list[tuple[float, float]] = []   # (unix_ts, implied next-meeting bp)


def rate_shift_monitor() -> dict:
    """Snapshot the ZQ-implied next-meeting move; alert on intraday repricing."""
    fw = fedwatch.meeting_probabilities()
    nxt = next((m for m in fw.get("meetings", []) if m.get("ok")), None)
    now = time.time()
    out = {"ok": nxt is not None, "current_bp": None, "shift_30m": None,
           "shift_session": None, "alerts": [], "history": []}
    if not nxt:
        return out
    bp = float(nxt["implied_change_bp"])
    out["current_bp"] = bp
    out["meeting"] = nxt["meeting"]
    with _monitor_lock:
        if not _monitor_hist or now - _monitor_hist[-1][0] >= 55:
            _monitor_hist.append((now, bp))
        del _monitor_hist[:-720]                      # keep ~12h of minutes
        hist = list(_monitor_hist)
    base_30 = next((v for t, v in reversed(hist) if now - t >= 1800), None)
    base_day = hist[0][1] if hist else None
    if base_30 is not None:
        out["shift_30m"] = round(bp - base_30, 1)
        if abs(out["shift_30m"]) >= 3:
            out["alerts"].append({
                "id": f"rateshift30-{int(now // 1800)}",
                "kind": "rate-repricing",
                "text": (f"Fed repricing: the {nxt['meeting']} meeting moved "
                         f"{out['shift_30m']:+.1f}bp in the last 30 minutes "
                         f"(now {bp:+.1f}bp implied). Something is hitting the rates market - "
                         "check the squawk and watch ZN/ES react."),
            })
    if base_day is not None:
        out["shift_session"] = round(bp - base_day, 1)
        if abs(out["shift_session"]) >= 6:
            out["alerts"].append({
                "id": f"rateshiftday-{date.today()}-{int(abs(out['shift_session']) // 3)}",
                "kind": "rate-repricing",
                "text": (f"Major Fed repricing today: {out['shift_session']:+.1f}bp "
                         f"on the {nxt['meeting']} meeting since this session's first reading."),
            })
    step = max(1, len(hist) // 100)
    out["history"] = [{"t": int(t), "bp": round(v, 1)} for t, v in hist[::step]]
    return out


def _next_meeting(bank: dict) -> dict | None:
    today = datetime.now(ET).date()
    for m in bank["meetings"]:
        d = date.fromisoformat(m)
        if d >= today:
            return {"date": m, "days_until": (d - today).days, "approx": bank["meetings_approx"]}
    return None


def desk() -> dict:
    fw = fedwatch.meeting_probabilities()
    yc = fedwatch.yield_curve()
    monitor = rate_shift_monitor()

    banks_out = []
    rate_now: dict[str, float] = {}
    for key, b in BANKS.items():
        hist = []
        try:
            hist = policy_rate_history(b["bis"])
        except Exception:
            pass
        cur = hist[-1]["rate"] if hist else None
        yr_ago = next((h["rate"] for h in reversed(hist) if h["period"] <= hist[-1]["period"][:4]
                       and len(hist) > 13 and h == hist[-13]), None) if hist else None
        if hist and len(hist) >= 13:
            yr_ago = hist[-13]["rate"]
        if cur is not None:
            rate_now[key] = cur
        # trend over last 6 obs
        stance = "holding"
        if len(hist) >= 7:
            d6 = hist[-1]["rate"] - hist[-7]["rate"]
            stance = "hiking" if d6 > 0.05 else "cutting" if d6 < -0.05 else "holding"
        fx_quote = None
        if b["fx"]:
            q = md.get_quote(b["fx"])
            if q.get("ok"):
                fx_quote = {"symbol": b["fx"].replace("=F", ""), "last": q["last"],
                            "change_pct": q["change_pct"]}
        news = []
        try:
            news = bank_news(key)
        except Exception:
            pass
        banks_out.append({
            "key": key, "name": b["name"], "short": b["short"], "currency": b["currency"],
            "rate": cur, "rate_1y_ago": yr_ago,
            "stance": stance,
            "history": [{"period": h["period"], "rate": h["rate"]} for h in hist[-130:]],
            "next_meeting": _next_meeting(b),
            "decision_time": b["decision_time"],
            "watch": b["watch"],
            "fx": fx_quote,
            "news": news,
        })

    divergences = []
    if "fed" in rate_now:
        for k, label, fx in (("ecb", "Fed-ECB", "6E"), ("boj", "Fed-BoJ", "6J"), ("boe", "Fed-BoE", "6B")):
            if k in rate_now:
                diff = round(rate_now["fed"] - rate_now[k], 2)
                divergences.append({
                    "pair": label, "differential": diff, "fx_future": fx,
                    "read": (f"{label} differential {diff:+.2f}%. Rate differentials drive currency-futures "
                             f"trends: when this gap WIDENS the dollar side strengthens ({fx} falls), when it "
                             f"NARROWS {fx} rallies. Repricing of either bank's path shows up here first."),
                })

    return {
        "ok": True,
        "asof": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "fedwatch": fw,
        "yield_curve": yc,
        "monitor": monitor,
        "banks": banks_out,
        "divergences": divergences,
        "prep_process": {
            "title": "Decision-Day Prep Process",
            "items": [
                "What is priced in? Read the implied path below BEFORE the event - the trade is the gap between pricing and delivery, not the decision itself.",
                "Diff the language: what changed vs the last statement? One altered adjective ('persistent' -> 'moderating') can be worth 20 ES points.",
                "Projections vs pricing: when the committee's own forecasts (dots) sit far from market pricing, one of them has to move.",
                "Know what the committee currently cares about (inflation? labor? stability?) - that decides which data releases matter until the next meeting.",
                "Pre-write the three scenarios (dovish / in-line / hawkish) with planned reactions - or plan to stand aside. Deciding mid-spike is how accounts get hurt.",
            ],
        },
        "how_to_read": (
            "Each bank card shows its official policy rate (BIS data), the direction of travel, the next "
            "scheduled decision, the currency future it drives, and the freshest headlines/analyst takes. "
            "The Fed gets full probability math because Fed Funds futures trade freely; for the others, watch "
            "the currency future and the differential - that's where their repricing is visible intraday."),
    }
