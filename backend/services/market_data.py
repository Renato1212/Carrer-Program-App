"""Free market data via Yahoo Finance (yfinance).

All futures day-trader instruments plus the cross-asset tape that drives them.
Everything is cached briefly so the app stays inside free-tier etiquette.
"""
from __future__ import annotations

import math
import os
from datetime import datetime, time as dtime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

from backend.cache import ttl_cache

# Serverless filesystems are read-only outside /tmp; keep yfinance caches there.
if os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
    os.environ.setdefault("HOME", "/tmp")
    os.environ.setdefault("XDG_CACHE_HOME", "/tmp/.cache")
    try:
        yf.set_tz_cache_location("/tmp/yf-tz-cache")
    except Exception:
        pass

ET = ZoneInfo("America/New_York")

# The board every index/rates/energy/metals day trader watches.
INSTRUMENTS = {
    "ES": {"yahoo": "ES=F", "name": "E-mini S&P 500", "tick": 0.25, "tick_value": 12.50, "group": "Equity Index"},
    "NQ": {"yahoo": "NQ=F", "name": "E-mini Nasdaq 100", "tick": 0.25, "tick_value": 5.00, "group": "Equity Index"},
    "YM": {"yahoo": "YM=F", "name": "E-mini Dow", "tick": 1.0, "tick_value": 5.00, "group": "Equity Index"},
    "RTY": {"yahoo": "RTY=F", "name": "E-mini Russell 2000", "tick": 0.10, "tick_value": 5.00, "group": "Equity Index"},
    "CL": {"yahoo": "CL=F", "name": "Crude Oil WTI", "tick": 0.01, "tick_value": 10.00, "group": "Energy"},
    "NG": {"yahoo": "NG=F", "name": "Natural Gas", "tick": 0.001, "tick_value": 10.00, "group": "Energy"},
    "GC": {"yahoo": "GC=F", "name": "Gold", "tick": 0.10, "tick_value": 10.00, "group": "Metals"},
    "SI": {"yahoo": "SI=F", "name": "Silver", "tick": 0.005, "tick_value": 25.00, "group": "Metals"},
    "HG": {"yahoo": "HG=F", "name": "Copper", "tick": 0.0005, "tick_value": 12.50, "group": "Metals"},
    "ZB": {"yahoo": "ZB=F", "name": "30Y T-Bond", "tick": 0.03125, "tick_value": 31.25, "group": "Rates"},
    "ZN": {"yahoo": "ZN=F", "name": "10Y T-Note", "tick": 0.015625, "tick_value": 15.625, "group": "Rates"},
    "ZF": {"yahoo": "ZF=F", "name": "5Y T-Note", "tick": 0.0078125, "tick_value": 7.8125, "group": "Rates"},
    "6E": {"yahoo": "6E=F", "name": "Euro FX", "tick": 0.00005, "tick_value": 6.25, "group": "FX"},
    "6J": {"yahoo": "6J=F", "name": "Japanese Yen", "tick": 0.0000005, "tick_value": 6.25, "group": "FX"},
    "BTC": {"yahoo": "BTC=F", "name": "Bitcoin Futures", "tick": 5.0, "tick_value": 25.00, "group": "Crypto"},
}

# Context tape: not tradeable here but drives everything.
CONTEXT_TICKERS = {
    "VIX": {"yahoo": "^VIX", "name": "VIX"},
    "DXY": {"yahoo": "DX-Y.NYB", "name": "Dollar Index"},
    "US10Y": {"yahoo": "^TNX", "name": "10Y Yield"},
    "US2Y": {"yahoo": "2YY=F", "name": "2Y Yield Fut"},
    "US30Y": {"yahoo": "^TYX", "name": "30Y Yield"},
    "US5Y": {"yahoo": "^FVX", "name": "5Y Yield"},
    "US13W": {"yahoo": "^IRX", "name": "13W Bill"},
}


def _safe(v):
    if v is None:
        return None
    try:
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return None


@ttl_cache(seconds=15)
def get_quote(symbol: str) -> dict:
    """Last price / change for one instrument or context ticker."""
    meta = INSTRUMENTS.get(symbol) or CONTEXT_TICKERS.get(symbol)
    yahoo = meta["yahoo"] if meta else symbol
    out = {"symbol": symbol, "name": meta["name"] if meta else symbol}
    try:
        t = yf.Ticker(yahoo)
        fi = t.fast_info
        last = _safe(getattr(fi, "last_price", None))
        prev = _safe(getattr(fi, "previous_close", None))
        out.update({
            "last": last,
            "prev_close": prev,
            "change": round(last - prev, 6) if last is not None and prev is not None else None,
            "change_pct": round((last - prev) / prev * 100, 3) if last and prev else None,
            "day_high": _safe(getattr(fi, "day_high", None)),
            "day_low": _safe(getattr(fi, "day_low", None)),
            "ok": last is not None,
        })
    except Exception as e:  # network blocked / ticker missing -> degrade, never crash
        out.update({"ok": False, "error": str(e)[:200]})
    return out


@ttl_cache(seconds=20)
def get_board() -> dict:
    """Full futures board + context tape."""
    futures = [get_quote(s) for s in INSTRUMENTS]
    context = [get_quote(s) for s in CONTEXT_TICKERS]
    return {"futures": futures, "context": context, "asof": datetime.now(ET).isoformat()}


@ttl_cache(seconds=60)
def get_history(symbol: str, period: str = "5d", interval: str = "5m") -> pd.DataFrame:
    meta = INSTRUMENTS.get(symbol) or CONTEXT_TICKERS.get(symbol)
    yahoo = meta["yahoo"] if meta else symbol
    df = yf.Ticker(yahoo).history(period=period, interval=interval, prepost=True)
    if df is None or df.empty:
        raise ValueError(f"no data for {symbol} ({yahoo})")
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    df.index = df.index.tz_convert(ET)
    return df


def get_candles(symbol: str, period: str = "5d", interval: str = "5m") -> dict:
    try:
        df = get_history(symbol, period, interval)
    except Exception as e:
        return {"symbol": symbol, "ok": False, "error": str(e)[:200], "candles": []}
    candles = [
        {
            "time": int(ts.timestamp()),
            "open": round(float(r.Open), 6),
            "high": round(float(r.High), 6),
            "low": round(float(r.Low), 6),
            "close": round(float(r.Close), 6),
            "volume": int(r.Volume) if not math.isnan(r.Volume) else 0,
        }
        for ts, r in df.iterrows()
        if not math.isnan(r.Open)
    ]
    return {"symbol": symbol, "ok": True, "interval": interval, "candles": candles}


def rth_sessions(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Split intraday frame into RTH sessions (09:30-16:00 ET) keyed by date string."""
    rth = df[(df.index.time >= dtime(9, 30)) & (df.index.time < dtime(16, 0))]
    out = {}
    for d, g in rth.groupby(rth.index.date):
        if len(g) >= 3:
            out[str(d)] = g
    return out


def overnight_session(df: pd.DataFrame, for_date) -> pd.DataFrame:
    """Globex overnight: prior day 18:00 ET -> session day 09:30 ET."""
    start = datetime.combine(for_date - timedelta(days=1), dtime(18, 0), tzinfo=ET)
    # weekends: Sunday open covers Monday's overnight
    if for_date.weekday() == 0:
        start = datetime.combine(for_date - timedelta(days=1), dtime(18, 0), tzinfo=ET)
    end = datetime.combine(for_date, dtime(9, 30), tzinfo=ET)
    return df[(df.index >= start) & (df.index < end)]


def relative_volume_curve(symbol: str) -> dict:
    """Average volume per 30-min slot over recent sessions vs today.

    Day 4 principle: use the volume-by-time profile to find the hours where
    breakouts are most likely to work and where S/R is most likely to hold.
    """
    try:
        df = get_history(symbol, "1mo", "30m")
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}
    df = df.copy()
    df["slot"] = df.index.strftime("%H:%M")
    today = datetime.now(ET).date()
    hist = df[df.index.date < today]
    cur = df[df.index.date == today]
    avg = hist.groupby("slot")["Volume"].mean()
    today_v = cur.groupby("slot")["Volume"].sum()
    slots = sorted(avg.index)
    return {
        "ok": True,
        "slots": slots,
        "avg": [int(avg.get(s, 0)) for s in slots],
        "today": [int(today_v.get(s, 0)) for s in slots],
    }
