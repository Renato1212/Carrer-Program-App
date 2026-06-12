"""Advanced Market Profile workbench.

Builds N sessions side-by-side on a SHARED price grid so profiles are directly
comparable: TPO counts and volume-at-price per bucket per session, value areas
at a configurable percentage, IB, open/close, day types, rotation factor,
single prints, poor extremes and naked-POC tracking - for RTH, overnight
(Globex) or full 24h sessions.
"""
from __future__ import annotations

from datetime import time as dtime, timedelta

import numpy as np
import pandas as pd

from backend.cache import ttl_cache
from backend.services import market_data as md
from backend.services import profile as prof


def _sessions_by_mode(df: pd.DataFrame, mode: str) -> dict[str, pd.DataFrame]:
    if mode == "rth":
        return md.rth_sessions(df)
    # Assign each bar to its trading session date by shifting +6h:
    # 18:00 (Globex open) -> next calendar day; 16:00 close -> same day.
    shifted = df.index + pd.Timedelta(hours=6)
    key = pd.Series(shifted.date, index=df.index)
    if mode == "eth":
        mask = (df.index.time >= dtime(18, 0)) | (df.index.time < dtime(9, 30))
    else:  # all (full session)
        mask = (df.index.time >= dtime(18, 0)) | (df.index.time < dtime(16, 0))
    out = {}
    sub = df[mask]
    for d, g in sub.groupby(key[mask]):
        if len(g) >= 4:
            out[str(d)] = g
    return out


def _value_area(counts: np.ndarray, poc_i: int, pct: float) -> tuple[int, int]:
    total = counts.sum() or 1
    va = {poc_i}
    cov = counts[poc_i]
    while cov < pct / 100 * total:
        lo, hi = min(va) - 1, max(va) + 1
        cl = counts[lo] if lo >= 0 else -1
        ch = counts[hi] if hi < len(counts) else -1
        if cl < 0 and ch < 0:
            break
        if cl >= ch:
            va.add(lo); cov += cl
        else:
            va.add(hi); cov += ch
    return min(va), max(va)


def _rotation_factor(g: pd.DataFrame) -> int:
    rf = 0
    h = g.High.to_numpy(float); l = g.Low.to_numpy(float)
    for i in range(1, len(h)):
        rf += 1 if h[i] > h[i - 1] else (-1 if h[i] < h[i - 1] else 0)
        rf += 1 if l[i] > l[i - 1] else (-1 if l[i] < l[i - 1] else 0)
    return rf


@ttl_cache(seconds=90)
def workbench(symbol: str, days: int = 10, session: str = "rth", va_pct: float = 70.0,
              ticks_per_row: int = 0) -> dict:
    days = max(2, min(days, 20))
    va_pct = min(max(va_pct, 50), 95)
    session = session if session in ("rth", "eth", "all") else "rth"
    df30 = md.get_history(symbol, "2mo" if days > 10 else "1mo", "30m")
    sess = _sessions_by_mode(df30, session)
    keys = sorted(sess)[-days:]
    if len(keys) < 2:
        raise ValueError("not enough sessions for the workbench")

    glob_hi = max(float(sess[k].High.max()) for k in keys)
    glob_lo = min(float(sess[k].Low.min()) for k in keys)
    tick = md.INSTRUMENTS.get(symbol, {}).get("tick", 0.25)
    span = glob_hi - glob_lo
    if ticks_per_row and ticks_per_row > 0:
        mult = int(ticks_per_row)
        if span / (mult * tick) > 900:
            raise ValueError(
                f"{mult} tick(s) per row gives {int(span / (mult * tick))} rows over this range - "
                f"too fine to render. Increase ticks per row (or reduce the day count).")
    else:
        mult = max(1, round(span / 200 / tick))      # auto: <=~200 shared rows
    step = mult * tick
    base = np.floor(glob_lo / step) * step
    n_rows = int(np.ceil((glob_hi - base) / step)) + 1
    grid = np.round(base + np.arange(n_rows) * step, 10)

    sessions_out = []
    sum_tpo = np.zeros(n_rows)
    sum_vol = np.zeros(n_rows)
    for ki, k in enumerate(keys):
        g = sess[k]
        tpo = np.zeros(n_rows)
        vol = np.zeros(n_rows)
        dlt = np.zeros(n_rows)
        period_ranges = []
        pv_sum = v_sum = 0.0
        for _, bar in g.iterrows():
            b_lo, b_hi, v = float(bar.Low), float(bar.High), float(bar.Volume)
            b_o, b_c = float(bar.Open), float(bar.Close)
            i0 = max(0, int((b_lo - base) // step))
            i1 = min(n_rows - 1, int((b_hi - base) // step))
            tpo[i0:i1 + 1] += 1
            period_ranges.append([i0, i1])
            rng = b_hi - b_lo
            # delta proxy: bar volume signed by where the close sits in the bar's range
            sgn = (((b_c - b_lo) - (b_hi - b_c)) / rng) if rng > 0 else 0.0
            if v > 0 and rng > 0:
                pv_sum += v * (b_hi + b_lo + b_c) / 3
                v_sum += v
                for i in range(i0, i1 + 1):
                    ov = max(0.0, min(b_hi, grid[i] + step) - max(b_lo, grid[i]))
                    share = v * ov / rng
                    vol[i] += share
                    dlt[i] += share * sgn
        vwap = pv_sum / v_sum if v_sum else None
        sum_tpo += tpo
        sum_vol += vol
        nz = np.nonzero(tpo)[0]
        lo_i, hi_i = int(nz[0]), int(nz[-1])
        mid_i = (lo_i + hi_i) / 2
        poc_i = int(max(np.nonzero(tpo == tpo.max())[0], key=lambda i: -abs(i - mid_i)))
        val_i, vah_i = _value_area(tpo, poc_i, va_pct)
        ib = g.iloc[:2]
        ibh, ibl = float(ib.High.max()), float(ib.Low.min())
        o, c = float(g.iloc[0].Open), float(g.iloc[-1].Close)
        hi, lo = float(g.High.max()), float(g.Low.min())
        counts_d = {float(grid[i]): int(tpo[i]) for i in nz}
        prices_d = sorted(counts_d, reverse=True)
        dtp = prof.classify_day_type(o, c, hi, lo, ibh, ibl, counts_d, prices_d)
        singles = [i for i in range(lo_i + 2, hi_i - 1) if tpo[i] == 1]
        # naked POC: does any later session trade through this POC?
        poc_px = float(grid[poc_i])
        naked_until = None
        tested = False
        for k2 in keys[ki + 1:]:
            g2 = sess[k2]
            if float(g2.Low.min()) <= poc_px <= float(g2.High.max()):
                naked_until = k2
                tested = True
                break
        sessions_out.append({
            "day": k,
            "tpo": [int(x) for x in tpo],
            "vol": [int(x) for x in vol],
            "dlt": [int(x) for x in dlt],
            "period_ranges": period_ranges,
            "vwap": round(vwap, 4) if vwap else None,
            "delta_total": int(dlt.sum()),
            "poc_i": poc_i, "vah_i": int(vah_i), "val_i": int(val_i),
            "hi_i": hi_i, "lo_i": lo_i,
            "ib_hi": round(ibh, 4), "ib_lo": round(ibl, 4),
            "open": round(o, 4), "close": round(c, 4),
            "high": round(hi, 4), "low": round(lo, 4),
            "day_type": dtp["type"],
            "close_loc": dtp["close_location"],
            "ib_pct": dtp["ib_pct_of_range"],
            "rf": _rotation_factor(g),
            "volume_total": int(vol.sum()),
            "value_width": round((vah_i - val_i) * step, 4),
            "poor_high": int(tpo[hi_i]) >= 2,
            "poor_low": int(tpo[lo_i]) >= 2,
            "singles_i": singles[:25],
            "poc_price": round(poc_px, 4),
            "naked": not tested,
            "naked_until": naked_until,
        })

    cpoc_i = int(sum_tpo.argmax())
    cval_i, cvah_i = _value_area(sum_tpo, cpoc_i, va_pct)
    last_px = float(df30.iloc[-1].Close)
    return {
        "ok": True, "symbol": symbol, "session_mode": session, "va_pct": va_pct,
        "step": step, "tick": tick, "ticks_per_row": mult,
        "grid": [round(float(p), 4) for p in grid],
        "last": round(last_px, 4),
        "sessions": sessions_out,
        "composite": {"tpo": [int(x) for x in sum_tpo], "vol": [int(x) for x in sum_vol],
                      "poc_i": cpoc_i, "vah_i": int(cvah_i), "val_i": int(cval_i)},
        "legend": {
            "rf": "Rotation factor: net half-hour rotations (+ = buyers winning the auction bar by bar).",
            "naked": "Dashed ray = naked POC: never revisited since that session - a live magnet.",
            "modes": "TPO = time at price (acceptance). Volume = contracts at price (participation). "
                     "Delta = net aggressive buying minus selling per price (proxy). "
                     "Compare them: volume without time = an event; time without volume = drift.",
        },
    }
