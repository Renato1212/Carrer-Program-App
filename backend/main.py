"""EdgeDesk - futures day-trader command center.

Run:  uvicorn backend.main:app --reload --port 8000
Then open http://localhost:8000
"""
from __future__ import annotations

from pathlib import Path

from fastapi import Body, FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.services import (briefing, composite, correlations, econ_calendar,
                              fedwatch, flow, gameplan, journal, levels,
                              market_data, news, orderflow, playbooks,
                              predictions, profile, profile_adv, sentiment)

app = FastAPI(title="EdgeDesk", version="1.1",
              description="Free-data command center for futures day traders")

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"


def guard(fn, *args, **kwargs):
    """No data hiccup may ever surface as a bare 500 - the frontend renders
    {ok: false, error} as a labeled message inside the panel instead."""
    try:
        return fn(*args, **kwargs)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}


@app.exception_handler(Exception)
async def catch_all(request, exc):
    return JSONResponse({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]})


# ----- market data -----
@app.get("/api/board")
def board():
    return guard(market_data.get_board)


@app.get("/api/candles/{symbol}")
def candles(symbol: str, period: str = "5d", interval: str = "5m"):
    return guard(market_data.get_candles, symbol.upper(), period, interval)


@app.get("/api/relative-volume/{symbol}")
def rel_volume(symbol: str):
    return guard(market_data.relative_volume_curve, symbol.upper())


# ----- technicals -----
@app.get("/api/profile/{symbol}")
def session_profile(symbol: str, day: str | None = Query(default=None)):
    return guard(profile.session_profile, symbol.upper(), day)


@app.get("/api/composite/{symbol}")
def composite_profile(symbol: str, days: int = 10):
    return guard(composite.composite_pack, symbol.upper(), days)


@app.get("/api/profile-advanced/{symbol}")
def profile_advanced(symbol: str, days: int = 10, session: str = "rth", va: float = 70.0,
                     tpr: int = 0):
    return guard(profile_adv.workbench, symbol.upper(), days, session, va, tpr)


@app.get("/api/gameplan/{symbol}")
def game_plan(symbol: str):
    return guard(gameplan.build, symbol.upper())


@app.get("/api/levels/{symbol}")
def key_levels(symbol: str):
    return guard(levels.key_levels, symbol.upper())


# ----- macro / central banks -----
@app.get("/api/central-banks")
def central_banks():
    return guard(fedwatch.central_bank_desk)


@app.get("/api/correlations")
def corr(window: int = 20):
    return guard(correlations.correlation_matrix, window)


# ----- scheduled + unscheduled news -----
@app.get("/api/calendar")
def calendar(days: int = 21, country: str = ""):
    return guard(econ_calendar.upcoming, days, country)


@app.get("/api/news")
def get_news():
    return guard(news.get_news)


@app.get("/api/sentiment")
def market_sentiment():
    return guard(sentiment.desk)


# ----- flow -----
@app.get("/api/flow")
def flow_desk(symbol: str = "ES"):
    return guard(flow.flow_desk, symbol.upper())


# ----- order flow pulse -----
@app.get("/api/orderflow/{symbol}")
def orderflow_pulse(symbol: str):
    return guard(orderflow.pulse, symbol.upper())


# ----- prediction markets -----
@app.get("/api/predictions")
def prediction_markets():
    return guard(predictions.desk)


# ----- briefing & playbooks -----
@app.get("/api/briefing")
def get_briefing(symbol: str = "ES"):
    return guard(briefing.premarket_briefing, symbol.upper())


@app.get("/api/playbooks")
def get_playbooks():
    return guard(playbooks.get_playbooks)


# ----- journal -----
@app.get("/api/journal/trades")
def trades():
    return guard(lambda: {"ok": True, "trades": journal.list_trades()})


@app.post("/api/journal/trades")
def add_trade(trade: dict = Body(...)):
    return guard(journal.add_trade, trade)


@app.delete("/api/journal/trades/{trade_id}")
def delete_trade(trade_id: int):
    return guard(journal.delete_trade, trade_id)


@app.get("/api/journal/metrics")
def journal_metrics():
    return guard(journal.metrics)


# ----- frontend -----
@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
