"""EdgeDesk - futures day-trader command center.

Run:  uvicorn backend.main:app --reload --port 8000
Then open http://localhost:8000
"""
from __future__ import annotations

from pathlib import Path

from fastapi import Body, FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import os
import threading
import time as _time

from backend.services import (briefing, central_banks, composite, correlations,
                              econ_calendar, fedwatch, flow, gameplan, journal,
                              levels, market_data, news, orderflow, paper,
                              patterns, playbooks, predictions, profile,
                              profile_adv, rithmic, sentiment, simbook)

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


@app.get("/api/patterns/{symbol}")
def chart_patterns(symbol: str):
    return guard(patterns.detect, symbol.upper())


# ----- macro / central banks -----
@app.get("/api/central-banks")
def central_banks_desk():
    return guard(central_banks.desk)


@app.get("/api/alerts")
def live_alerts():
    """Aggregated real-time alerts: rate repricings, critical headlines, prediction swings."""
    def build():
        out = []
        mon = central_banks.rate_shift_monitor()
        out.extend(mon.get("alerts", []))
        nw = news.get_news()
        for a in (nw.get("alerts") or [])[:6]:
            if a["tier"] == "critical" and (a.get("age_min") or 9e9) < 60:
                out.append({"id": "news-" + a["id"], "kind": "headline",
                            "text": f"CRITICAL: {a['title']} ({a['source']}) - watch {'/'.join(a['impacts'])}"})
        pr = predictions.desk()
        for m in (pr.get("swing_alerts") or [])[:3]:
            if abs(m["change_24h"]) >= 10:
                out.append({"id": f"pred-{m['question'][:40]}", "kind": "prediction",
                            "text": (f"Prediction market repricing: \"{m['question']}\" now {m['prob']}% "
                                     f"({m['change_24h']:+.0f}pts/24h) - watch {'/'.join(m['impacts'])}")})
        return {"ok": True, "alerts": out[:10]}
    return guard(build)


# ----- rithmic connectivity -----
@app.get("/api/rithmic/status")
def rithmic_status():
    return guard(rithmic.status)


@app.post("/api/rithmic/connect")
def rithmic_connect(body: dict = Body(...)):
    user = (body.get("user") or "").strip()
    password = body.get("password") or ""
    system = (body.get("system") or "").strip()
    if not user or not password or not system:
        return {"ok": False, "error": "user, password and system are all required"}
    return guard(rithmic.connect, user, password, system, body.get("gateway"))


@app.post("/api/rithmic/disconnect")
def rithmic_disconnect():
    return guard(rithmic.disconnect)


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


# ----- DOM / simulated trading -----
@app.get("/api/dom/{symbol}")
def dom_snapshot(symbol: str):
    def build():
        snap = simbook.step(symbol.upper())
        if not snap.get("ok"):
            return snap
        paper.process(symbol.upper(), snap["last"], snap["bid"], snap["ask"])
        snap["account"] = paper.account(symbol.upper(), snap["last"])
        return snap
    return guard(build)


@app.post("/api/paper/order")
def paper_order(body: dict = Body(...)):
    return guard(paper.place_order, body.get("symbol", "ES"), body.get("side", ""),
                 body.get("qty", 1), body.get("otype", "market"), body.get("price"),
                 body.get("stop_loss"), body.get("take_profit"))


@app.post("/api/paper/cancel/{order_id}")
def paper_cancel(order_id: int):
    return guard(paper.cancel_order, order_id)


@app.post("/api/paper/flatten")
def paper_flatten(body: dict = Body(...)):
    sym = (body.get("symbol") or "ES").upper()
    def run():
        snap = simbook.step(sym)
        if not snap.get("ok") or not snap.get("last"):
            return {"ok": False, "error": "no market price available - cannot flatten safely right now"}
        return paper.flatten(sym, snap["last"])
    return guard(run)


@app.get("/api/paper/dashboard")
def paper_dashboard():
    return guard(paper.dashboard)


@app.post("/api/paper/reset")
def paper_reset():
    return guard(paper.reset_account)


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


# ----- background warmer: keeps hot endpoints precomputed on persistent hosts -----
def _warm_loop():
    while True:
        for fn in (market_data.get_board, news.get_news,
                   lambda: gameplan.build("ES"), lambda: econ_calendar.upcoming(14),
                   lambda: patterns.detect("ES")):
            try:
                fn()
            except Exception:
                pass
        _time.sleep(75)


@app.on_event("startup")
def _start_warmer():
    if not (os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME")):
        threading.Thread(target=_warm_loop, daemon=True).start()


# ----- frontend -----
@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
