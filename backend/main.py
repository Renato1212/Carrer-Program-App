"""EdgeDesk - futures day-trader command center.

Run:  uvicorn backend.main:app --reload --port 8000
Then open http://localhost:8000
"""
from __future__ import annotations

from pathlib import Path

from fastapi import Body, FastAPI, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.services import (briefing, correlations, econ_calendar, fedwatch,
                              flow, journal, levels, market_data, news,
                              playbooks, profile)

app = FastAPI(title="EdgeDesk", version="1.0",
              description="Free-data command center for futures day traders")

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"


# ----- market data -----
@app.get("/api/board")
def board():
    return market_data.get_board()


@app.get("/api/candles/{symbol}")
def candles(symbol: str, period: str = "5d", interval: str = "5m"):
    return market_data.get_candles(symbol.upper(), period, interval)


@app.get("/api/relative-volume/{symbol}")
def rel_volume(symbol: str):
    return market_data.relative_volume_curve(symbol.upper())


# ----- technicals -----
@app.get("/api/profile/{symbol}")
def session_profile(symbol: str, day: str | None = Query(default=None)):
    return profile.session_profile(symbol.upper(), day)


@app.get("/api/levels/{symbol}")
def key_levels(symbol: str):
    return levels.key_levels(symbol.upper())


# ----- macro / central banks -----
@app.get("/api/central-banks")
def central_banks():
    return fedwatch.central_bank_desk()


@app.get("/api/correlations")
def corr(window: int = 20):
    return correlations.correlation_matrix(window)


# ----- scheduled + unscheduled news -----
@app.get("/api/calendar")
def calendar(days: int = 21):
    return econ_calendar.upcoming(days)


@app.get("/api/news")
def get_news():
    return news.get_news()


# ----- flow -----
@app.get("/api/flow")
def flow_desk(symbol: str = "ES"):
    return flow.flow_desk(symbol.upper())


# ----- briefing & playbooks -----
@app.get("/api/briefing")
def get_briefing(symbol: str = "ES"):
    return briefing.premarket_briefing(symbol.upper())


@app.get("/api/playbooks")
def get_playbooks():
    return playbooks.get_playbooks()


# ----- journal -----
@app.get("/api/journal/trades")
def trades():
    return {"ok": True, "trades": journal.list_trades()}


@app.post("/api/journal/trades")
def add_trade(trade: dict = Body(...)):
    try:
        return journal.add_trade(trade)
    except (KeyError, ValueError, TypeError) as e:
        return {"ok": False, "error": f"invalid trade: {e}"}


@app.delete("/api/journal/trades/{trade_id}")
def delete_trade(trade_id: int):
    return journal.delete_trade(trade_id)


@app.get("/api/journal/metrics")
def journal_metrics():
    return journal.metrics()


# ----- frontend -----
@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
