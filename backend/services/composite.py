"""Multi-day composite engine - the context a single-day profile can't give.

Three reads traders actually use:
1. Composite volume profile over N sessions: the real HVN/LVN magnets.
2. Value migration: how value moved day over day (the auction's trend).
3. Unfinished business: naked POCs, unfilled gaps, untested poor extremes -
   magnets the market tends to come back for.
"""
from __future__ import annotations

import numpy as np

from backend.services import market_data as md
from backend.services import profile as prof


def _value_relation(cur: dict, prev: dict) -> str:
    if cur["val"] > prev["vah"]:
        return "higher"
    if cur["vah"] < prev["val"]:
        return "lower"
    if cur["vah"] <= prev["vah"] and cur["val"] >= prev["val"]:
        return "inside"
    return "overlap-up" if cur["poc"] >= prev["poc"] else "overlap-down"

RELATION_LABEL = {
    "higher": "value HIGHER", "lower": "value LOWER", "inside": "value INSIDE (coiling)",
    "overlap-up": "overlapping-higher", "overlap-down": "overlapping-lower",
}


def composite_pack(symbol: str, days: int = 10) -> dict:
    df30 = md.get_history(symbol, "1mo", "30m")
    sessions = md.rth_sessions(df30)
    all_days = sorted(sessions)
    use_days = all_days[-days:]
    if len(use_days) < 2:
        raise ValueError("need at least 2 sessions of data")

    # ---- per-session summaries + value migration ----
    summaries = []
    for d in use_days:
        t = prof.build_tpo(symbol, sessions[d])
        summaries.append({
            "day": d, "open": t["open"], "high": t["high"], "low": t["low"], "close": t["close"],
            "poc": t["poc"], "vah": t["vah"], "val": t["val"],
            "day_type": t["day_type"]["type"],
            "poor_high": t["poor_high"], "poor_low": t["poor_low"],
        })
    for i, s in enumerate(summaries):
        s["relation"] = _value_relation(s, summaries[i - 1]) if i else None
        s["relation_label"] = RELATION_LABEL.get(s["relation"], "") if i else ""

    # value trend verdict from last 4 relations
    recent = [s["relation"] for s in summaries[-4:] if s["relation"]]
    ups = sum(r in ("higher", "overlap-up") for r in recent)
    downs = sum(r in ("lower", "overlap-down") for r in recent)
    if ups >= 3:
        trend = ("up", "Value has migrated HIGHER - buyers control the auction. Pullbacks into prior "
                       "value are buy candidates until a value-lower day appears.")
    elif downs >= 3:
        trend = ("down", "Value has migrated LOWER - sellers control the auction. Rallies into prior "
                         "value are sell candidates until a value-higher day appears.")
    elif all(r == "inside" or r and r.startswith("overlap") for r in recent) and recent:
        trend = ("balance", "Value is overlapping/inside for several sessions - the market is BALANCING. "
                            "Expect rotation between composite value edges; the eventual break carries "
                            "stored energy.")
    else:
        trend = ("mixed", "Value migration is mixed - two-sided auction, take what each side gives and "
                          "keep size honest.")

    # ---- composite volume profile ----
    rows = [sessions[d] for d in use_days]
    his = max(float(r.High.max()) for r in rows)
    los = min(float(r.Low.min()) for r in rows)
    bins = 60
    edges = np.linspace(los, his, bins + 1)
    vols = np.zeros(bins)
    for r in rows:
        for _, bar in r.iterrows():
            b_lo, b_hi, v = float(bar.Low), float(bar.High), float(bar.Volume)
            if v <= 0 or b_hi <= b_lo:
                continue
            lo_i = np.searchsorted(edges, b_lo, "right") - 1
            hi_i = np.searchsorted(edges, b_hi, "left")
            for i in range(max(lo_i, 0), min(hi_i, bins)):
                ov = max(0.0, min(b_hi, edges[i + 1]) - max(b_lo, edges[i]))
                vols[i] += v * ov / (b_hi - b_lo)
    mids = (edges[:-1] + edges[1:]) / 2
    total = vols.sum() or 1.0
    poc_i = int(vols.argmax())
    va = {poc_i}; covered = vols[poc_i]
    while covered < 0.70 * total:
        lo_i, hi_i = min(va) - 1, max(va) + 1
        vl = vols[lo_i] if lo_i >= 0 else -1
        vh = vols[hi_i] if hi_i < bins else -1
        if vl < 0 and vh < 0:
            break
        if vl >= vh:
            va.add(lo_i); covered += vl
        else:
            va.add(hi_i); covered += vh
    mean_v = vols.mean()
    hvn = [round(float(mids[i]), 4) for i in range(bins) if vols[i] > 1.7 * mean_v]
    lvn = [round(float(mids[i]), 4) for i in range(1, bins - 1)
           if vols[i] < 0.4 * mean_v and vols[i] <= vols[i - 1] and vols[i] <= vols[i + 1]]

    # ---- unfinished business ----
    last_px = float(df30.iloc[-1].Close)
    naked_pocs, unfilled_gaps, untested_extremes = [], [], []
    for i, s in enumerate(summaries[:-1]):
        later = summaries[i + 1:]
        if not any(l["low"] <= s["poc"] <= l["high"] for l in later):
            naked_pocs.append({"day": s["day"], "price": s["poc"],
                               "distance": round(last_px - s["poc"], 4)})
        nxt = summaries[i + 1]
        if nxt["open"] > s["close"] and not any(l["low"] <= s["close"] for l in later):
            unfilled_gaps.append({"day": nxt["day"], "from": s["close"], "to": nxt["open"],
                                  "side": "below", "distance": round(last_px - s["close"], 4)})
        elif nxt["open"] < s["close"] and not any(l["high"] >= s["close"] for l in later):
            unfilled_gaps.append({"day": nxt["day"], "from": nxt["open"], "to": s["close"],
                                  "side": "above", "distance": round(last_px - s["close"], 4)})
        if s["poor_high"] and not any(l["high"] >= s["high"] for l in later):
            untested_extremes.append({"day": s["day"], "price": s["high"], "kind": "poor high",
                                      "distance": round(last_px - s["high"], 4)})
        if s["poor_low"] and not any(l["low"] <= s["low"] for l in later):
            untested_extremes.append({"day": s["day"], "price": s["low"], "kind": "poor low",
                                      "distance": round(last_px - s["low"], 4)})

    return {
        "ok": True, "symbol": symbol, "days_used": len(use_days), "last": last_px,
        "value_trend": {"direction": trend[0], "note": trend[1]},
        "sessions": summaries,
        "composite": {
            "levels": [{"price": round(float(m), 4), "volume": int(v)} for m, v in zip(mids, vols)],
            "poc": round(float(mids[poc_i]), 4),
            "vah": round(float(mids[max(va)]), 4),
            "val": round(float(mids[min(va)]), 4),
            "hvn": hvn[:8], "lvn": lvn[:8],
        },
        "naked_pocs": sorted(naked_pocs, key=lambda x: abs(x["distance"]))[:6],
        "unfilled_gaps": sorted(unfilled_gaps, key=lambda x: abs(x["distance"]))[:4],
        "untested_extremes": sorted(untested_extremes, key=lambda x: abs(x["distance"]))[:4],
        "explainers": {
            "composite": "The N-day composite shows where the market has ACCEPTED price (fat = HVN magnets) "
                         "and rejected it (thin = LVN vacuum). Price travels fast through thin zones and "
                         "slows inside fat ones - target the next fat zone, risk behind the thin one.",
            "naked_poc": "Naked POC = a prior day's fairest price never revisited. Strong magnet - markets "
                         "have a habit of coming back to finish that business.",
            "migration": "Each row = one auction. Read the Relation column top-down to see who has been "
                         "winning the war for value - that's your strategic bias, updated daily.",
        },
    }
