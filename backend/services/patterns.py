"""Swing-structure and chart-pattern engine.

Detects what a discretionary trader actually marks on an intraday chart:
swing highs/lows (fractal pivots), the structural sequence (HH/HL vs LH/LL),
compression coils (contracting swings on declining volume), double tops and
bottoms, and proximity to multi-day breakout levels - returned both as chart
markers and as plain-language reads.
"""
from __future__ import annotations

import numpy as np

from backend.cache import ttl_cache
from backend.services import market_data as md


def _pivots(h: np.ndarray, l: np.ndarray, k: int = 3) -> list[dict]:
    out = []
    for i in range(k, len(h) - k):
        if h[i] == h[i - k:i + k + 1].max() and h[i] > h[i - k:i].max():
            out.append({"i": i, "kind": "high", "price": float(h[i])})
        if l[i] == l[i - k:i + k + 1].min() and l[i] < l[i - k:i].min():
            out.append({"i": i, "kind": "low", "price": float(l[i])})
    return out


@ttl_cache(seconds=90)
def detect(symbol: str) -> dict:
    df = md.get_history(symbol, "5d", "5m").tail(450)
    if len(df) < 60:
        raise ValueError("not enough intraday data for structure detection")
    h = df.High.to_numpy(float)
    l = df.Low.to_numpy(float)
    c = df.Close.to_numpy(float)
    v = np.nan_to_num(df.Volume.to_numpy(float))
    times = [int(ts.timestamp()) for ts in df.index]
    atr = float(np.mean(h[-60:] - l[-60:])) or 1e-9

    piv = _pivots(h, l)
    markers = [{"time": times[p["i"]],
                "position": "aboveBar" if p["kind"] == "high" else "belowBar",
                "color": "#98989f", "shape": "circle",
                "text": "H" if p["kind"] == "high" else "L"}
               for p in piv[-24:]]
    reads = []

    highs = [p for p in piv if p["kind"] == "high"]
    lows = [p for p in piv if p["kind"] == "low"]

    # ---- structural sequence ----
    structure = "undefined"
    if len(highs) >= 2 and len(lows) >= 2:
        hh = highs[-1]["price"] > highs[-2]["price"]
        hl = lows[-1]["price"] > lows[-2]["price"]
        if hh and hl:
            structure = "uptrend (HH + HL)"
            reads.append("Structure is bullish: the last swing high AND swing low are both higher. "
                         "Pullbacks that hold above the last higher-low keep the sequence intact; "
                         "losing it is the first objective warning.")
        elif not hh and not hl:
            structure = "downtrend (LH + LL)"
            reads.append("Structure is bearish: lower high and lower low. Rallies that stall under the "
                         "last lower-high are continuation setups; reclaiming it breaks the sequence.")
        else:
            structure = "two-sided / transitioning"
            reads.append("Mixed structure (one side made a higher point, the other a lower one) - the market "
                         "is transitioning or ranging. Edges of the recent range matter more than direction.")

    # ---- compression / coil ----
    coil = None
    if len(piv) >= 6:
        recent = piv[-4:]
        older = piv[-8:-4] if len(piv) >= 8 else piv[:-4]
        amp_r = max(p["price"] for p in recent) - min(p["price"] for p in recent)
        amp_o = max(p["price"] for p in older) - min(p["price"] for p in older) if older else amp_r
        vol_recent = float(v[recent[0]["i"]:].mean()) if recent[0]["i"] < len(v) - 1 else 0
        vol_before = float(v[:recent[0]["i"]].mean()) or 1
        if amp_o > 0 and amp_r / amp_o < 0.6:
            coil = {"hi": round(max(p["price"] for p in recent), 4),
                    "lo": round(min(p["price"] for p in recent), 4),
                    "vol_drying": vol_recent < vol_before * 0.85}
            markers.append({"time": times[recent[-1]["i"]], "position": "aboveBar",
                            "color": "#ffd60a", "shape": "arrowDown", "text": "COIL"})
            reads.append(f"Compression coil: swings contracted to {coil['lo']:g}-{coil['hi']:g}"
                         + (" with volume drying up" if coil["vol_drying"] else "")
                         + ". Compressed time + volume with clear invalidations on both sides stores energy - "
                           "the break tends to be fast. Trade the break WITH initiative volume, "
                           "stop behind the opposite side of the coil.")

    # ---- double top / bottom ----
    if len(highs) >= 2:
        a, b = highs[-2], highs[-1]
        if abs(a["price"] - b["price"]) < 0.25 * atr and b["i"] - a["i"] >= 6:
            neck = min(p["price"] for p in lows if a["i"] < p["i"] < b["i"]) if any(a["i"] < p["i"] < b["i"] for p in lows) else None
            markers.append({"time": times[b["i"]], "position": "aboveBar",
                            "color": "#ff453a", "shape": "arrowDown", "text": "DT"})
            reads.append(f"Double top at {b['price']:g}: the second test failed to take out the first - "
                         "buyers who chased the retest are trapped above"
                         + (f"; the pattern confirms below the neckline at {neck:g}" if neck else "")
                         + ". Failed second tests work because of those trapped positions, not the shape itself.")
    if len(lows) >= 2:
        a, b = lows[-2], lows[-1]
        if abs(a["price"] - b["price"]) < 0.25 * atr and b["i"] - a["i"] >= 6:
            neck = max(p["price"] for p in highs if a["i"] < p["i"] < b["i"]) if any(a["i"] < p["i"] < b["i"] for p in highs) else None
            markers.append({"time": times[b["i"]], "position": "belowBar",
                            "color": "#30d158", "shape": "arrowUp", "text": "DB"})
            reads.append(f"Double bottom at {b['price']:g}: sellers failed to extend on the retest"
                         + (f"; confirms above the neckline at {neck:g}" if neck else "")
                         + ". Shorts pressing into the second low are the fuel for the bounce.")

    # ---- breakout proximity ----
    period_hi, period_lo = float(h.max()), float(l.min())
    last = float(c[-1])
    if period_hi - last < 0.6 * atr:
        reads.append(f"Price is within one rotation of the 5-day high ({period_hi:g}). Stops cluster just above "
                     "multi-day extremes - expect acceleration through it, then judge follow-through vs stop-run.")
    if last - period_lo < 0.6 * atr:
        reads.append(f"Price is within one rotation of the 5-day low ({period_lo:g}). Same logic in reverse: "
                     "stops below feed the break, the first minutes after decide if it's real.")

    if not reads:
        reads.append("No standout structural pattern right now - normal two-way rotation. The absence of a "
                     "pattern is information: don't manufacture a trade where the market offers none.")

    markers.sort(key=lambda m: m["time"])
    return {
        "ok": True, "symbol": symbol, "structure": structure,
        "markers": markers[-30:], "reads": reads[:5],
        "coil": coil,
        "period_high": round(period_hi, 4), "period_low": round(period_lo, 4),
        "how_to_read": ("Grey dots mark confirmed swing pivots (they appear a few bars late by definition - "
                        "a pivot needs bars on both sides). Patterns matter because of the POSITIONS they "
                        "trap, not their shapes: every read explains who is wrong and where they get out."),
    }
