"""Flow desk: dealer gamma exposure (GEX), max pain, put/call ratio and the
expiration calendar - computed free from Yahoo option chains on the index
proxies (SPY->ES, QQQ->NQ, IWM->RTY).

Standard dealer-positioning convention: dealers are long customer-sold calls /
short customer-bought puts -> Net GEX = call gamma - put gamma. Positive net
gamma pins price (mean reversion); negative gamma amplifies moves. The zero-
gamma flip is the regime boundary every index day trader should know each day.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import yfinance as yf

from backend.cache import ttl_cache

ET = ZoneInfo("America/New_York")
PROXIES = {"ES": "SPY", "NQ": "QQQ", "RTY": "IWM"}


def _bs_gamma(spot, strike, t_years, iv, r=0.04):
    if t_years <= 0 or iv <= 0 or spot <= 0:
        return 0.0
    d1 = (math.log(spot / strike) + (r + iv * iv / 2) * t_years) / (iv * math.sqrt(t_years))
    pdf = math.exp(-d1 * d1 / 2) / math.sqrt(2 * math.pi)
    return pdf / (spot * iv * math.sqrt(t_years))


@ttl_cache(seconds=600)
def gex_profile(symbol: str = "ES") -> dict:
    proxy = PROXIES.get(symbol, "SPY")
    try:
        tk = yf.Ticker(proxy)
        spot = float(tk.fast_info.last_price)
        expiries = tk.options[:6]  # near-dated dominates intraday gamma
        if not expiries:
            return {"ok": False, "error": "no option chain available"}
        today = datetime.now(ET).date()
        strikes: dict[float, dict] = {}
        total_call_oi = total_put_oi = 0
        pain: dict[float, float] = {}
        for exp in expiries:
            chain = tk.option_chain(exp)
            dte = max((date.fromisoformat(exp) - today).days, 0)
            t = max(dte, 0.5) / 365.0
            for kind, df in (("call", chain.calls), ("put", chain.puts)):
                for _, row in df.iterrows():
                    k = float(row.strike)
                    if not (0.75 * spot < k < 1.25 * spot):
                        continue
                    oi = float(row.openInterest or 0)
                    iv = float(row.impliedVolatility or 0)
                    if oi <= 0:
                        continue
                    g = _bs_gamma(spot, k, t, iv) * oi * 100 * spot * spot * 0.01
                    s = strikes.setdefault(k, {"call_gex": 0.0, "put_gex": 0.0,
                                               "call_oi": 0, "put_oi": 0})
                    if kind == "call":
                        s["call_gex"] += g; s["call_oi"] += oi; total_call_oi += oi
                    else:
                        s["put_gex"] += g; s["put_oi"] += oi; total_put_oi += oi
        # max pain on front expiry only
        front = tk.option_chain(expiries[0])
        ks = sorted({float(k) for k in front.calls.strike} & {float(k) for k in front.puts.strike})
        ks = [k for k in ks if 0.85 * spot < k < 1.15 * spot]
        for settle in ks:
            cost = 0.0
            for _, r_ in front.calls.iterrows():
                if 0.85 * spot < float(r_.strike) < 1.15 * spot:
                    cost += max(0.0, settle - float(r_.strike)) * float(r_.openInterest or 0)
            for _, r_ in front.puts.iterrows():
                if 0.85 * spot < float(r_.strike) < 1.15 * spot:
                    cost += max(0.0, float(r_.strike) - settle) * float(r_.openInterest or 0)
            pain[settle] = cost
        max_pain = min(pain, key=pain.get) if pain else None

        rows = sorted(strikes.items())
        net = [(k, v["call_gex"] - v["put_gex"]) for k, v in rows]
        total_net = sum(g for _, g in net)
        # zero-gamma flip: cumulative-from-bottom sign change nearest to spot
        flip = None
        cum = 0.0
        for (k, g), (k2, g2) in zip(net, net[1:]):
            cum += g
            cum2 = cum + g2
            if cum <= 0 <= cum2 or cum2 <= 0 <= cum:
                flip = k2 if flip is None or abs(k2 - spot) < abs(flip - spot) else flip
        regime = "positive" if total_net > 0 else "negative"
        return {
            "ok": True, "symbol": symbol, "proxy": proxy, "spot": round(spot, 2),
            "expiries_used": list(expiries),
            "strikes": [{"strike": k, "net_gex": round(v["call_gex"] - v["put_gex"], 0),
                         "call_oi": int(v["call_oi"]), "put_oi": int(v["put_oi"])}
                        for k, v in rows],
            "total_net_gex": round(total_net, 0),
            "zero_gamma": flip,
            "max_pain_front": max_pain,
            "put_call_oi_ratio": round(total_put_oi / total_call_oi, 2) if total_call_oi else None,
            "regime": regime,
            "read": ("POSITIVE net gamma: dealers fade moves - expect pinning/mean reversion around the big "
                     "strikes; breakout trades need extra confirmation."
                     if regime == "positive" else
                     "NEGATIVE net gamma: dealers chase moves - trends extend, vol expands. Momentum playbook "
                     "on; respect stop-run acceleration through LVNs (Day 12/13)."),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def expiration_calendar(weeks: int = 8) -> list[dict]:
    today = datetime.now(ET).date()
    out = []
    d = today
    end = today + timedelta(weeks=weeks)
    while d <= end:
        if d.weekday() == 4:  # Fridays
            third = (d.day - 1) // 7 == 2
            if third:
                quad = d.month in (3, 6, 9, 12)
                out.append({"date": d.isoformat(),
                            "event": "Quad Witching" if quad else "Monthly OPEX",
                            "impact": "high",
                            "note": "Index futures + options expire together" if quad
                            else "Monthly options expiry - pin risk near large OI strikes"})
            else:
                out.append({"date": d.isoformat(), "event": "Weekly OPEX", "impact": "low",
                            "note": "Weekly expiry - 0DTE gamma resets"})
        if d.weekday() == 2 and 15 <= d.day <= 21:
            out.append({"date": d.isoformat(), "event": "VIX Expiration", "impact": "medium",
                        "note": "VIX options settle on the AM print"})
        last_bd = d.month != (d + timedelta(days=1)).month and d.weekday() < 5
        if last_bd:
            out.append({"date": d.isoformat(), "event": "Month End", "impact": "medium",
                        "note": "Rebalancing flows into the close"})
        d += timedelta(days=1)
    for e in out:
        e["days_until"] = (date.fromisoformat(e["date"]) - today).days
    return out


def flow_desk(symbol: str = "ES") -> dict:
    return {
        "gex": gex_profile(symbol),
        "expirations": expiration_calendar(),
        "playbook": [
            "Daily: locate spot vs zero-gamma flip. Above in +gamma = rotational day types more likely; below in -gamma = trend/liquidation day types more likely. Marry this to your Day 7 day-type read.",
            "OPEX week: large OI strikes act like HVN magnets - combine with the profile's POC for confluence targets.",
            "Big OI strike + LVN behind it = asymmetric breakout spot when gamma is negative.",
            "Post-OPEX Monday: the pin is gone - ranges expand, yesterday's 'respected' level may vaporize.",
        ],
    }
