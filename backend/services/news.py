"""Unscheduled-news radar: free RSS aggregation with severity scoring.

Parses official central-bank wires + financial media with stdlib XML (no
feedparser needed). Each headline is scored against tiered keyword lists so
crisis/geopolitical shocks float to the top with the instruments they hit.
"""
from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET_XML
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx

from backend.cache import ttl_cache

FEEDS = [
    {"source": "Federal Reserve", "url": "https://www.federalreserve.gov/feeds/press_all.xml", "weight": 2.0},
    {"source": "ECB", "url": "https://www.ecb.europa.eu/rss/press.html", "weight": 1.5},
    {"source": "CNBC Top News", "url": "https://www.cnbc.com/id/100003114/device/rss/rss.html", "weight": 1.0},
    {"source": "CNBC Economy", "url": "https://www.cnbc.com/id/20910258/device/rss/rss.html", "weight": 1.2},
    {"source": "MarketWatch", "url": "https://feeds.content.dowjones.io/public/rss/mw_topstories", "weight": 1.0},
    {"source": "Yahoo Finance", "url": "https://finance.yahoo.com/news/rssindex", "weight": 0.8},
    {"source": "BLS", "url": "https://www.bls.gov/feed/news_release.rss", "weight": 1.5},
]

# severity tiers: (score, keywords)
KEYWORDS = [
    (10, ["emergency", "intermeeting", "halted", "circuit breaker", "default",
          "invasion", "invades", "missile", "strikes on", "airstrike", "nuclear",
          "declares war", "bank run", "collapse", "bailout", "contagion", "flash crash"]),
    (7, ["war", "attack", "sanctions", "tariff", "opec", "embargo", "downgrade",
         "credit rating", "shutdown", "debt ceiling", "resign", "fired", "blockade",
         "strait of hormuz", "escalation", "retaliation", "cyberattack"]),
    (5, ["fed", "fomc", "powell", "rate cut", "rate hike", "inflation", "cpi", "recession",
         "treasury yields", "ecb", "lagarde", "boj", "yen intervention", "stimulus",
         "quantitative", "unemployment", "payrolls", "geopolit"]),
    (3, ["earnings", "guidance", "oil", "crude", "gold", "dollar", "bond", "yield",
         "volatility", "vix", "selloff", "rally", "plunge", "surge", "soars", "tumbles"]),
]

IMPACT_MAP = [
    (["oil", "crude", "opec", "hormuz", "embargo", "barrel"], ["CL", "NG"]),
    (["gold", "safe haven", "nuclear", "war", "invasion", "missile", "geopolit"], ["GC", "SI"]),
    (["fed", "fomc", "rate", "inflation", "cpi", "treasury", "yield", "powell"], ["ZN", "ZB", "ES", "NQ"]),
    (["yen", "boj", "japan"], ["6J", "NQ"]),
    (["ecb", "euro", "lagarde"], ["6E"]),
    (["tech", "nasdaq", "ai ", "chip", "semiconductor"], ["NQ"]),
    (["bitcoin", "crypto"], ["BTC"]),
]


def _score(text: str) -> int:
    t = text.lower()
    s = 0
    for pts, words in KEYWORDS:
        if any(w in t for w in words):
            s = max(s, pts)
    return s


def _impacts(text: str) -> list[str]:
    t = text.lower()
    hits: list[str] = []
    for words, syms in IMPACT_MAP:
        if any(w in t for w in words):
            hits.extend(s for s in syms if s not in hits)
    return hits or ["ES"]


def _parse_feed(xml_text: str, source: str, weight: float) -> list[dict]:
    items = []
    try:
        root = ET_XML.fromstring(xml_text.encode() if isinstance(xml_text, str) else xml_text)
    except ET_XML.ParseError:
        return items
    ns = {"atom": "http://www.w3.org/2005/Atom", "dc": "http://purl.org/dc/elements/1.1/"}
    nodes = root.findall(".//item") or root.findall(".//atom:entry", ns)
    for it in nodes[:25]:
        def grab(*tags):
            for tg in tags:
                el = it.find(tg, ns)
                if el is not None and (el.text or el.get("href")):
                    return (el.text or el.get("href", "")).strip()
            return ""
        title = html.unescape(re.sub(r"<[^>]+>", "", grab("title", "atom:title")))
        link = grab("link", "atom:link")
        pub = grab("pubDate", "atom:updated", "atom:published", "dc:date")
        ts = None
        for parser in (parsedate_to_datetime, datetime.fromisoformat):
            try:
                ts = parser(pub.replace("Z", "+00:00") if parser is datetime.fromisoformat else pub)
                break
            except Exception:
                continue
        if ts and ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if not title:
            continue
        sev = _score(title)
        items.append({
            "title": title, "link": link, "source": source,
            "published": ts.isoformat() if ts else None,
            "age_min": int((datetime.now(timezone.utc) - ts).total_seconds() // 60) if ts else None,
            "severity": round(sev * weight, 1),
            "tier": "critical" if sev >= 10 else "high" if sev >= 7 else "macro" if sev >= 5 else "normal",
            "impacts": _impacts(title),
        })
    return items


@ttl_cache(seconds=90)
def get_news() -> dict:
    all_items, errors = [], []
    with httpx.Client(timeout=8, headers={"User-Agent": "Mozilla/5.0 (EdgeDesk RSS)"},
                      follow_redirects=True) as client:
        for f in FEEDS:
            try:
                r = client.get(f["url"])
                r.raise_for_status()
                all_items.extend(_parse_feed(r.text, f["source"], f["weight"]))
            except Exception as e:
                errors.append({"source": f["source"], "error": str(e)[:120]})
    all_items.sort(key=lambda x: (-(x["severity"]), x["age_min"] if x["age_min"] is not None else 9e9))
    alerts = [i for i in all_items if i["tier"] in ("critical", "high") and (i["age_min"] or 9e9) < 720]
    by_time = sorted([i for i in all_items if i["age_min"] is not None], key=lambda x: x["age_min"])
    return {
        "ok": len(all_items) > 0, "alerts": alerts[:10], "latest": by_time[:40],
        "errors": errors,
        "playbook": [
            "Unscheduled shock: first 60-90s is forced repositioning, not opinion. Don't fade tier-critical headlines early.",
            "Map WHO is trapped by the move (Day 3) - liquidation has a target: their last defense level.",
            "If you don't understand the headline's mechanism, flatten and study it for next time (Day 1).",
            "Crisis tape = wider stops or smaller size, never both sides of that tradeoff ignored.",
        ],
    }
