"""News squawk engine: broad free RSS aggregation with severity scoring,
category classification and instrument tagging.

Official central-bank wires + fast market-news feeds, parsed with stdlib XML
(namespace-agnostic: RSS 2.0, RSS 1.0/RDF, Atom). Each headline is scored so
crisis/geopolitical shocks float to the top tagged with the futures they hit.
"""
from __future__ import annotations

import hashlib
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
    {"source": "Bank of England", "url": "https://www.bankofengland.co.uk/rss/news", "weight": 1.3},
    {"source": "BLS", "url": "https://www.bls.gov/feed/news_release.rss", "weight": 1.5},
    {"source": "CNBC Top News", "url": "https://www.cnbc.com/id/100003114/device/rss/rss.html", "weight": 1.0},
    {"source": "CNBC Economy", "url": "https://www.cnbc.com/id/20910258/device/rss/rss.html", "weight": 1.2},
    {"source": "CNBC Markets", "url": "https://www.cnbc.com/id/20910250/device/rss/rss.html", "weight": 1.0},
    {"source": "MarketWatch", "url": "https://feeds.content.dowjones.io/public/rss/mw_topstories", "weight": 1.0},
    {"source": "MarketWatch Pulse", "url": "https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines", "weight": 1.1},
    {"source": "ForexLive", "url": "https://www.forexlive.com/feed/news", "weight": 1.2},
    {"source": "FXStreet", "url": "https://www.fxstreet.com/rss/news", "weight": 1.0},
    {"source": "Yahoo Finance", "url": "https://finance.yahoo.com/news/rssindex", "weight": 0.8},
    {"source": "Reuters (via Google)", "url": "https://news.google.com/rss/search?q=site:reuters.com+(markets+OR+fed+OR+economy)&hl=en-US&gl=US&ceid=US:en", "weight": 1.2},
    {"source": "Bloomberg (via Google)", "url": "https://news.google.com/rss/search?q=site:bloomberg.com+(markets+OR+fed+OR+treasury)&hl=en-US&gl=US&ceid=US:en", "weight": 1.2},
    {"source": "ZeroHedge", "url": "https://feeds.feedburner.com/zerohedge/feed", "weight": 0.7},
]

# severity tiers: (score, keywords)
KEYWORDS = [
    (10, ["emergency", "intermeeting", "halted", "circuit breaker", "default",
          "invasion", "invades", "missile", "strikes on", "airstrike", "nuclear",
          "declares war", "bank run", "collapse", "bailout", "contagion", "flash crash"]),
    (7, ["war", "attack", "sanctions", "tariff", "opec", "embargo", "downgrade",
         "credit rating", "shutdown", "debt ceiling", "resign", "fired", "blockade",
         "strait of hormuz", "escalation", "retaliation", "cyberattack", "martial law"]),
    (5, ["fed", "fomc", "powell", "rate cut", "rate hike", "inflation", "cpi", "recession",
         "treasury yields", "ecb", "lagarde", "boj", "yen intervention", "stimulus",
         "quantitative", "unemployment", "payrolls", "geopolit", "intervention"]),
    (3, ["earnings", "guidance", "oil", "crude", "gold", "dollar", "bond", "yield",
         "volatility", "vix", "selloff", "rally", "plunge", "surge", "soars", "tumbles"]),
]

CATEGORIES = [
    ("central-bank", ["fed", "fomc", "powell", "ecb", "lagarde", "boj", "boe", "rate cut",
                      "rate hike", "central bank", "monetary", "dovish", "hawkish", "qt", "qe"]),
    ("geopolitics", ["war", "invasion", "missile", "attack", "sanctions", "nuclear", "military",
                     "nato", "ukraine", "russia", "china", "taiwan", "iran", "israel", "strike",
                     "ceasefire", "embargo", "blockade"]),
    ("energy", ["oil", "crude", "opec", "natural gas", "barrel", "wti", "brent", "refinery"]),
    ("data", ["cpi", "inflation", "payroll", "jobs report", "gdp", "retail sales", "pmi", "ism",
              "jobless", "unemployment", "ppi", "pce", "consumer confidence"]),
    ("markets", ["stocks", "futures", "s&p", "nasdaq", "dow", "treasury", "bond", "yield",
                 "dollar", "gold", "bitcoin", "vix", "rally", "selloff"]),
]

IMPACT_MAP = [
    (["oil", "crude", "opec", "hormuz", "embargo", "barrel", "refinery"], ["CL", "NG"]),
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


def _category(text: str) -> str:
    t = text.lower()
    for cat, words in CATEGORIES:
        if any(w in t for w in words):
            return cat
    return "other"


def _impacts(text: str) -> list[str]:
    t = text.lower()
    hits: list[str] = []
    for words, syms in IMPACT_MAP:
        if any(w in t for w in words):
            hits.extend(s for s in syms if s not in hits)
    return hits or ["ES"]


def _local(tag) -> str:
    return str(tag).rsplit("}", 1)[-1].lower()


def _parse_feed(xml_text: str, source: str, weight: float) -> list[dict]:
    items = []
    try:
        root = ET_XML.fromstring(xml_text.encode() if isinstance(xml_text, str) else xml_text)
    except ET_XML.ParseError:
        return items
    nodes = [el for el in root.iter() if _local(el.tag) in ("item", "entry")]
    for it in nodes[:30]:
        fields: dict[str, str] = {}
        for child in it:
            name = _local(child.tag)
            val = (child.text or "").strip() or (child.get("href") or "").strip()
            if val and name not in fields:
                fields[name] = val

        def grab(*names):
            for n in names:
                if fields.get(n):
                    return fields[n]
            return ""
        title = html.unescape(re.sub(r"<[^>]+>", "", grab("title")))
        link = grab("link", "id")
        pub = grab("pubdate", "updated", "published", "date")
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
            "id": hashlib.md5((source + title).encode()).hexdigest()[:12],
            "title": title, "link": link, "source": source,
            "published": ts.isoformat() if ts else None,
            "age_min": int((datetime.now(timezone.utc) - ts).total_seconds() // 60) if ts else None,
            "severity": round(sev * weight, 1),
            "tier": "critical" if sev >= 10 else "high" if sev >= 7 else "macro" if sev >= 5 else "normal",
            "category": _category(title),
            "impacts": _impacts(title),
        })
    return items


@ttl_cache(seconds=75)
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
    seen, dedup = set(), []
    for i in sorted(all_items, key=lambda x: x["age_min"] if x["age_min"] is not None else 9e9):
        k = i["title"][:70].lower()
        if k not in seen:
            seen.add(k)
            dedup.append(i)
    alerts = sorted([i for i in dedup if i["tier"] in ("critical", "high") and (i["age_min"] or 9e9) < 720],
                    key=lambda x: (-x["severity"], x["age_min"] or 9e9))
    return {
        "ok": len(dedup) > 0,
        "alerts": alerts[:12],
        "latest": dedup[:120],
        "errors": errors,
        "sources_ok": len(FEEDS) - len(errors),
        "sources_total": len(FEEDS),
        "how_to_read": (
            "On a sudden headline, the first 60-90 seconds of movement is forced repositioning, not "
            "considered opinion - fading a critical-tier headline early is how accounts blow up. Identify "
            "which side of the market is trapped by the news: their forced exit is usually the move that "
            "follows. If you don't understand a headline's mechanism, stay flat and study the reaction."),
    }
