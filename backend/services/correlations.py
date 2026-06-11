"""Rolling cross-asset correlation matrix - regime awareness (Day 1:
always be aware of environment and context).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import yfinance as yf

from backend.cache import ttl_cache

PAIRS = {
    "ES": "ES=F", "NQ": "NQ=F", "RTY": "RTY=F", "CL": "CL=F", "GC": "GC=F",
    "ZN": "ZN=F", "DXY": "DX-Y.NYB", "VIX": "^VIX", "BTC": "BTC-USD", "US10Y": "^TNX",
}


@ttl_cache(seconds=600)
def correlation_matrix(window: int = 20) -> dict:
    try:
        df = yf.download(list(PAIRS.values()), period="6mo", interval="1d",
                         progress=False, auto_adjust=True)["Close"]
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}
    if df is None or df.empty:
        return {"ok": False, "error": "no data"}
    inv = {v: k for k, v in PAIRS.items()}
    df = df.rename(columns=inv)
    rets = df.pct_change().dropna(how="all")
    recent = rets.tail(window)
    prior = rets.tail(window * 3).head(window)
    cur = recent.corr().round(2)
    prev = prior.corr().round(2)
    symbols = [s for s in PAIRS if s in cur.columns]
    matrix, changes = [], []
    for a in symbols:
        row = []
        for b in symbols:
            c = cur.at[a, b] if not np.isnan(cur.at[a, b]) else None
            row.append(c)
            if a < b and c is not None and not np.isnan(prev.at[a, b]):
                d = round(float(c - prev.at[a, b]), 2)
                if abs(d) >= 0.4:
                    changes.append({"pair": f"{a}/{b}", "now": float(c),
                                    "before": float(prev.at[a, b]), "shift": d})
        matrix.append(row)
    changes.sort(key=lambda x: -abs(x["shift"]))
    return {
        "ok": True, "window": window, "symbols": symbols, "matrix": matrix,
        "regime_shifts": changes[:6],
        "note": ("Correlation regime shifts ARE the macro narrative changing. When ES/ZN flips sign, "
                 "the market moved between 'good news is good' and inflation-fear regimes - your "
                 "playbook for rates headlines must flip with it."),
    }
