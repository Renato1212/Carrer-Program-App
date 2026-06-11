"""Prediction-markets desk: free public read APIs from Polymarket (gamma API)
and Kalshi. Crowd-priced probabilities on Fed decisions, recession, geopolitics
and macro outcomes - plus SWING detection: a market repricing hard in 24h is
often the first audible signal that positioning is changing, sometimes before
the headline crosses the wires.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import httpx

from backend.cache import ttl_cache
from backend.services.news import _impacts

POLYMARKET_URL = ("https://gamma-api.polymarket.com/markets"
                  "?closed=false&order=volume24hr&ascending=false&limit=120")
KALSHI_URL = "https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=200"

MACRO_WORDS = [
    "fed", "fomc", "rate cut", "rate hike", "interest rate", "powell", "cpi", "inflation",
    "recession", "gdp", "tariff", "treasury", "debt ceiling", "shutdown", "unemployment",
    "jobs", "payroll", "oil", "opec", "iran", "russia", "ukraine", "china", "taiwan",
    "israel", "nuclear", "war", "strike", "ceasefire", "sanctions", "bitcoin", "etf",
    "emergency", "bank", "default", "stock market", "s&p", "nasdaq", "vix", "gold",
]
SWING_ALERT_PTS = 0.08  # 8 probability points in 24h


def _is_macro(text: str) -> bool:
    t = text.lower()
    return any(w in t for w in MACRO_WORDS)


def _f(x, default=None):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


@ttl_cache(seconds=180)
def _polymarket() -> list[dict]:
    out = []
    with httpx.Client(timeout=10, headers={"User-Agent": "EdgeDesk/1.1"}) as client:
        r = client.get(POLYMARKET_URL)
        r.raise_for_status()
        for m in r.json():
            q = m.get("question") or ""
            if not q or not _is_macro(q):
                continue
            try:
                prices = json.loads(m.get("outcomePrices") or "[]")
                outcomes = json.loads(m.get("outcomes") or "[]")
            except (ValueError, TypeError):
                prices, outcomes = [], []
            prob = _f(prices[0]) if prices else _f(m.get("lastTradePrice"))
            if prob is None:
                continue
            out.append({
                "source": "Polymarket",
                "question": q,
                "outcome": outcomes[0] if outcomes else "Yes",
                "prob": round(prob * 100, 1),
                "change_24h": round((_f(m.get("oneDayPriceChange"), 0.0) or 0.0) * 100, 1),
                "volume_24h": round(_f(m.get("volume24hr"), 0.0) or 0.0),
                "ends": (m.get("endDate") or "")[:10],
                "url": f"https://polymarket.com/market/{m.get('slug', '')}",
                "impacts": _impacts(q),
            })
    return out


@ttl_cache(seconds=180)
def _kalshi() -> list[dict]:
    out = []
    with httpx.Client(timeout=10, headers={"User-Agent": "EdgeDesk/1.1"}) as client:
        r = client.get(KALSHI_URL)
        r.raise_for_status()
        for m in r.json().get("markets", []):
            title = m.get("title") or ""
            if not title or not _is_macro(title):
                continue
            prob = _f(m.get("last_price"))
            if prob is None or not m.get("volume_24h"):
                continue
            prev = _f(m.get("previous_price"), prob)
            out.append({
                "source": "Kalshi",
                "question": title,
                "outcome": m.get("yes_sub_title") or "Yes",
                "prob": round(prob, 1),                       # Kalshi prices are cents = pct
                "change_24h": round(prob - (prev if prev is not None else prob), 1),
                "volume_24h": int(m.get("volume_24h") or 0),
                "ends": (m.get("close_time") or "")[:10],
                "url": f"https://kalshi.com/markets/{m.get('ticker', '')}",
                "impacts": _impacts(title),
            })
    return out


def desk() -> dict:
    markets, errors = [], []
    for name, fn in (("Polymarket", _polymarket), ("Kalshi", _kalshi)):
        try:
            markets.extend(fn())
        except Exception as e:
            errors.append({"source": name, "error": str(e)[:150]})
    markets.sort(key=lambda m: -(m["volume_24h"] or 0))
    swings = sorted([m for m in markets if abs(m["change_24h"]) >= SWING_ALERT_PTS * 100],
                    key=lambda m: -abs(m["change_24h"]))
    return {
        "ok": len(markets) > 0,
        "asof": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "swing_alerts": swings[:8],
        "markets": markets[:40],
        "errors": errors,
        "playbook": [
            "Treat these as a SECOND OPINION vs ZQ-implied Fed pricing (Banks & Macro tab): when prediction "
            "markets and rate futures disagree, one of them is wrong - that gap is information.",
            "A hard repricing with no headline yet = positioning is changing before the news. Check the related "
            "futures (chips on each market) for early order-flow confirmation (Day 10: relative change).",
            "Geopolitical markets are a crisis radar for CL and GC - a war/strike market jumping 10+ points "
            "deserves a look at energy and metals before the wires catch up.",
            "Event-day base rates: what the crowd prices at 90%+ rarely moves markets when confirmed - "
            "the trade lives in the 30-70% zone where resolution genuinely repricess assets (Day 14).",
        ],
    }


def top_swings_for_briefing(limit: int = 2) -> list[str]:
    """Compact swing lines for the morning briefing - best effort."""
    try:
        d = desk()
        return [f"Prediction market repricing: \"{m['question']}\" {m['prob']}% "
                f"({'+' if m['change_24h'] > 0 else ''}{m['change_24h']}pts/24h, {m['source']}) - "
                f"watch {'/'.join(m['impacts'])}"
                for m in d.get("swing_alerts", [])[:limit]]
    except Exception:
        return []
