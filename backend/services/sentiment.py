"""Market sentiment desk - free, keyless sources.

CNN Fear & Greed index, crypto Fear & Greed (alternative.me), VIX regime and
options put/call positioning, fused into one gauge with plain-language reads.
Sentiment is a CONTRARIAN tool at extremes and a confirmation tool mid-range.
"""
from __future__ import annotations

from datetime import datetime, timezone

import httpx

from backend.cache import ttl_cache
from backend.services import market_data as md

CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
CRYPTO_URL = "https://api.alternative.me/fng/?limit=2"


@ttl_cache(seconds=600)
def _cnn() -> dict | None:
    try:
        with httpx.Client(timeout=10, headers={"User-Agent": "Mozilla/5.0 (EdgeDesk)"}) as c:
            r = c.get(CNN_URL)
            r.raise_for_status()
            fg = r.json().get("fear_and_greed", {})
            return {
                "score": round(float(fg.get("score", 0)), 0),
                "rating": fg.get("rating", ""),
                "previous": round(float(fg.get("previous_close", 0)), 0),
                "week_ago": round(float(fg.get("previous_1_week", 0)), 0),
                "month_ago": round(float(fg.get("previous_1_month", 0)), 0),
            }
    except Exception:
        return None


@ttl_cache(seconds=600)
def _crypto() -> dict | None:
    try:
        with httpx.Client(timeout=10) as c:
            r = c.get(CRYPTO_URL)
            r.raise_for_status()
            rows = r.json().get("data", [])
            if not rows:
                return None
            return {"score": int(rows[0]["value"]), "rating": rows[0]["value_classification"],
                    "previous": int(rows[1]["value"]) if len(rows) > 1 else None}
    except Exception:
        return None


def _vix_regime(v: float | None) -> dict | None:
    if v is None:
        return None
    if v < 13:
        r, note = "complacent", ("Very low volatility. Ranges compress, breakouts fail more often, and "
                                 "the market is most vulnerable to a vol shock. Tight stops get respected; runners are rare.")
    elif v < 17:
        r, note = "calm", "Normal-low volatility - rotational sessions dominate. Mean-reversion plays around value tend to outperform chasing."
    elif v < 23:
        r, note = "normal", "Healthy two-way volatility. Both breakout and rotation strategies are viable - let the session structure decide."
    elif v < 30:
        r, note = "elevated", "Stress is in the price. Ranges expand: widen stops OR cut size - never keep both unchanged. Headlines hit harder here."
    else:
        r, note = "crisis", "Crisis volatility. Liquidity is thin, slippage is real, and intraday swings can equal a normal week. Survival sizing only."
    return {"vix": round(v, 2), "regime": r, "note": note}


def desk() -> dict:
    cnn = _cnn()
    crypto = _crypto()
    vix_q = md.get_quote("VIX")
    vix = _vix_regime(vix_q.get("last") if vix_q.get("ok") else None)

    components, score_parts = [], []
    if cnn:
        components.append({"name": "CNN Fear & Greed", "score": cnn["score"], "label": cnn["rating"],
                           "detail": f"prev {cnn['previous']} · week ago {cnn['week_ago']} · month ago {cnn['month_ago']}"})
        score_parts.append(cnn["score"])
    if crypto:
        components.append({"name": "Crypto Fear & Greed", "score": crypto["score"], "label": crypto["rating"],
                           "detail": f"prev {crypto['previous']}"})
        score_parts.append(crypto["score"])
    if vix:
        vix_score = max(0, min(100, 100 - (vix["vix"] - 10) * 3.5))
        components.append({"name": "VIX regime", "score": round(vix_score), "label": vix["regime"],
                           "detail": f"VIX {vix['vix']}"})
        score_parts.append(vix_score)

    composite = round(sum(score_parts) / len(score_parts)) if score_parts else None
    if composite is None:
        read = ""
    elif composite >= 75:
        read = ("EXTREME GREED. Crowded long positioning - upside continuation needs constant fresh buying. "
                "The asymmetric risk is a sharp air-pocket down on any negative surprise. Treat euphoric "
                "breakouts with suspicion; sentiment extremes are contrarian signals.")
    elif composite >= 55:
        read = "Greed-side but not extreme. Trend-following has the tailwind; dips into support get bought. Confirmation, not contrarian, territory."
    elif composite > 45:
        read = "Neutral sentiment. No crowd to fade - take direction from structure and flows instead of sentiment."
    elif composite > 25:
        read = "Fear-side. Rallies get sold, but seller exhaustion sets up sharp squeezes - watch for failed new lows."
    else:
        read = ("EXTREME FEAR. Panic positioning - everyone who wanted to sell likely has. The asymmetric "
                "risk flips to violent short-covering rallies. Sentiment extremes are contrarian signals; "
                "knife-catching still requires a level and a stop.")

    return {
        "ok": bool(components),
        "asof": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "composite": composite,
        "composite_read": read,
        "components": components,
        "vix": vix,
        "how_to_read": (
            "0 = maximum fear, 100 = maximum greed. Mid-range readings confirm the prevailing trend; "
            "extremes (<25 or >75) are contrarian - they mark crowded positioning where reversals start. "
            "Sentiment tells you WHO is positioned where; price tells you WHEN it unwinds."),
    }
