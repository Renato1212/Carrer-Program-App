"""Order-flow pulse from free 1-minute data.

No DOM/tick feed exists for free, but the Day 10 keyword is RELATIVE CHANGE -
and that we can measure: a buy/sell delta proxy per bar (volume split by where
the close sits in the bar's range), cumulative delta with divergence checks
(absorption), volume-spike events, and tape-speed vs the session's own norm.
"""
from __future__ import annotations

import math
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np

from backend.services import market_data as md

ET = ZoneInfo("America/New_York")


def _bar_delta(o, h, l, c, v):
    """Volume signed by close location in range: +v at high, -v at low."""
    rng = h - l
    if not v or v <= 0 or rng <= 0:
        return 0.0
    return v * (((c - l) - (h - c)) / rng)


def pulse(symbol: str, bars: int = 180) -> dict:
    df = md.get_history(symbol, "1d", "1m").tail(bars)
    if len(df) < 30:
        raise ValueError("not enough 1m data yet for this session")
    o = df.Open.to_numpy(float); h = df.High.to_numpy(float)
    l = df.Low.to_numpy(float); c = df.Close.to_numpy(float)
    v = np.nan_to_num(df.Volume.to_numpy(float))
    times = [int(ts.timestamp()) for ts in df.index]

    delta = np.array([_bar_delta(*x) for x in zip(o, h, l, c, v)])
    cum = np.cumsum(delta)

    # volume spikes: > 3x rolling median of prior 20 bars
    spikes = []
    for i in range(20, len(v)):
        base = np.median(v[i - 20:i]) or 1
        if v[i] > 3 * base and v[i] > 0:
            spikes.append({"time": times[i], "price": round(float(c[i]), 4),
                           "mult": round(float(v[i] / base), 1),
                           "side": "buy" if delta[i] > 0 else "sell"})
    spikes = spikes[-8:]

    # tape speed: last 5 bars volume vs session per-bar average
    sess_avg = float(v.mean()) or 1.0
    recent = float(v[-5:].mean())
    speed = recent / sess_avg

    # divergence / absorption read on the last ~30 bars
    look = min(30, len(c) - 1)
    px_chg = c[-1] - c[-look]
    dl_chg = cum[-1] - cum[-look]
    signals = []
    px_dir = 1 if px_chg > 0 else -1 if px_chg < 0 else 0
    dl_dir = 1 if dl_chg > 0 else -1 if dl_chg < 0 else 0
    if px_dir and dl_dir and px_dir != dl_dir:
        side = "sellers" if px_dir > 0 else "buyers"
        signals.append(f"Divergence: price moved {'up' if px_dir>0 else 'down'} while delta proxy went the other "
                       f"way - aggressive {side} are being absorbed. Watch for the unwind.")
    if speed > 2.0:
        signals.append(f"Tape speed {speed:.1f}x session average - acceleration phase. After a calm period this is "
                       "an entry clue; after an extended move it's an exit clue.")
    elif speed < 0.5:
        signals.append(f"Tape speed {speed:.1f}x - quiet tape. Manipulative ladder games live here; breakouts "
                       "lack fuel. Better to wait for participation.")
    if spikes and spikes[-1]["time"] >= times[-3]:
        s = spikes[-1]
        signals.append(f"Fresh {s['side']}-side volume burst ({s['mult']}x) at {s['price']} - check for follow-"
                       "through: spike + no progress at an extreme = exhaustion.")
    if not signals:
        signals.append("No notable relative change right now - the keyword is CHANGE; stand by until the tape shifts.")

    step = max(1, len(cum) // 120)
    return {
        "ok": True, "symbol": symbol,
        "asof": datetime.now(ET).isoformat(timespec="minutes"),
        "cum_delta": [{"time": times[i], "value": round(float(cum[i]), 0)} for i in range(0, len(cum), step)],
        "last_price": round(float(c[-1]), 4),
        "delta_last30": round(float(dl_chg), 0),
        "price_last30": round(float(px_chg), 4),
        "tape_speed": round(speed, 2),
        "spikes": spikes,
        "signals": signals,
        "note": ("Delta is a PROXY (volume split by close location in each 1m bar) - free feeds have no true "
                 "aggressor data. Use it for relative change, not absolute truth."),
    }
