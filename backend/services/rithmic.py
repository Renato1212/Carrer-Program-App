"""Rithmic connectivity adapter (prop-firm credentials: Apex, Lucid, TPT, ...).

Opens the path for EdgeDesk to consume REAL-TIME exchange data and evolve into
a trading front-end. Uses the community `async_rithmic` library (Rithmic's
protobuf protocol) when installed; everything degrades to a clear status
message when it isn't, or when running on a serverless host.

IMPORTANT REALITIES
- A live broker connection is a persistent socket: it works when EdgeDesk runs
  LOCALLY (uvicorn on your machine), never on serverless hosting like Vercel.
- Install the optional dependency first:  pip install async_rithmic
- Credentials are stored ONLY in data/rithmic.json on your machine (gitignored)
  and are sent nowhere except Rithmic's gateway.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

CREDS_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "rithmic.json"

_state = {
    "connected": False,
    "connecting": False,
    "error": None,
    "system": None,
    "user": None,
    "ticks": {},          # symbol -> {last, bid, ask, bid_size, ask_size, ts, trades: deque-ish list}
    "started": None,
}
_lock = threading.Lock()
_thread: threading.Thread | None = None

SYSTEMS = [
    "Rithmic Paper Trading", "Rithmic 01", "Apex", "TopstepTrader",
    "TradeFundrr", "MES Capital", "Bulenox", "PropShopTrader",
    "4PropTrader", "FastTrackTrading", "DayTraders.com", "10XFutures",
    "LucidTrading", "ThriveTrading", "MZpack",
]


def is_serverless() -> bool:
    return bool(os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))


def lib_available() -> tuple[bool, str]:
    try:
        import async_rithmic  # noqa: F401
        return True, getattr(async_rithmic, "__version__", "installed")
    except ImportError:
        return False, ("async_rithmic is not installed. Run `pip install async_rithmic` "
                       "in the environment where EdgeDesk runs, then restart.")


def save_credentials(user: str, password: str, system: str) -> None:
    CREDS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CREDS_PATH.write_text(json.dumps({"user": user, "password": password, "system": system}))
    try:
        os.chmod(CREDS_PATH, 0o600)
    except OSError:
        pass


def load_credentials() -> dict | None:
    if CREDS_PATH.exists():
        try:
            return json.loads(CREDS_PATH.read_text())
        except (ValueError, OSError):
            return None
    return None


def _run_client(creds: dict, symbols: list[tuple[str, str]]):
    """Background thread: own asyncio loop, persistent Rithmic connection."""
    import asyncio

    async def main():
        from async_rithmic import RithmicClient   # imported lazily; optional dep
        client = RithmicClient(
            user=creds["user"], password=creds["password"],
            system_name=creds["system"],
            app_name="EdgeDesk", app_version="1.0",
        )
        await client.connect()
        with _lock:
            _state.update(connected=True, connecting=False, error=None,
                          system=creds["system"], user=creds["user"], started=time.time())

        try:
            from async_rithmic import DataType
            flags = DataType.LAST_TRADE | DataType.BBO
        except Exception:
            flags = None

        async def on_tick(data):
            sym = str(data.get("symbol") or data.get("security_code") or "?")
            with _lock:
                t = _state["ticks"].setdefault(sym, {"trades": []})
                px = data.get("price") or data.get("trade_price")
                if px:
                    t["last"] = float(px)
                    t["trades"].append({"p": float(px), "s": int(data.get("size") or data.get("trade_size") or 0),
                                        "ts": time.time(),
                                        "side": data.get("aggressor") or ""})
                    del t["trades"][:-400]
                if data.get("bid_price"):
                    t["bid"], t["bid_size"] = float(data["bid_price"]), int(data.get("bid_size") or 0)
                if data.get("ask_price"):
                    t["ask"], t["ask_size"] = float(data["ask_price"]), int(data.get("ask_size") or 0)
                t["ts"] = time.time()

        try:
            client.on_tick += on_tick
        except Exception:
            pass
        for sym, exch in symbols:
            try:
                if flags is not None:
                    await client.subscribe_to_market_data(sym, exch, flags)
                else:
                    await client.subscribe_to_market_data(sym, exch)
            except Exception as e:
                with _lock:
                    _state["error"] = f"subscribe {sym}: {e}"[:200]
        while True:                                   # keep the connection alive
            await asyncio.sleep(5)
            with _lock:
                if not _state["connecting"] and not _state["connected"]:
                    break

    try:
        asyncio.run(main())
    except Exception as e:
        with _lock:
            _state.update(connected=False, connecting=False,
                          error=f"{type(e).__name__}: {e}"[:300])


def connect(user: str, password: str, system: str) -> dict:
    if is_serverless():
        return {"ok": False, "error": (
            "Live broker connections need a persistent process and cannot run on serverless hosting. "
            "Run EdgeDesk locally (`uvicorn backend.main:app --port 8000`) and connect there.")}
    ok, msg = lib_available()
    if not ok:
        return {"ok": False, "error": msg}
    global _thread
    with _lock:
        if _state["connecting"] or _state["connected"]:
            return {"ok": False, "error": "already connected/connecting - disconnect first"}
        _state.update(connecting=True, error=None)
    save_credentials(user, password, system)
    # front-month continuation aliases are resolved by Rithmic; CME micro/e-mini majors
    symbols = [("ESM6", "CME"), ("NQM6", "CME"), ("CLN6", "NYMEX"), ("GCQ6", "COMEX")]
    _thread = threading.Thread(target=_run_client,
                               args=({"user": user, "password": password, "system": system}, symbols),
                               daemon=True)
    _thread.start()
    return {"ok": True, "status": "connecting", "note": (
        "Connecting to Rithmic in the background. Poll /api/rithmic/status. If your prop firm uses a "
        "specific system name (e.g. 'Apex'), make sure it matches exactly what the firm gave you.")}


def disconnect() -> dict:
    with _lock:
        _state.update(connected=False, connecting=False)
    return {"ok": True}


def status() -> dict:
    ok_lib, lib_msg = lib_available()
    with _lock:
        ticks = {s: {k: v for k, v in t.items() if k != "trades"} | {"trades_cached": len(t.get("trades", []))}
                 for s, t in _state["ticks"].items()}
        return {
            "ok": True,
            "serverless": is_serverless(),
            "lib_installed": ok_lib,
            "lib_info": lib_msg,
            "connected": _state["connected"],
            "connecting": _state["connecting"],
            "error": _state["error"],
            "system": _state["system"],
            "user": (_state["user"][:3] + "***") if _state["user"] else None,
            "has_saved_credentials": load_credentials() is not None,
            "uptime_s": int(time.time() - _state["started"]) if _state["started"] else None,
            "ticks": ticks,
            "systems": SYSTEMS,
            "roadmap": [
                "Phase 1 (this build): credential vault + live tick/BBO feed into the quote board and order-flow pulse.",
                "Phase 2: true tick-based delta, DOM ladder and volume profile from Rithmic prints (no more proxies).",
                "Phase 3: order routing - bracket orders sized by the position sizer, with journal auto-logging.",
            ],
        }


def live_quote(symbol: str) -> dict | None:
    """Best-effort live quote for board integration (root match, e.g. ES -> ESM6)."""
    with _lock:
        if not _state["connected"]:
            return None
        for sym, t in _state["ticks"].items():
            if sym.startswith(symbol) and t.get("last"):
                return {"last": t["last"], "bid": t.get("bid"), "ask": t.get("ask"),
                        "source": "rithmic", "ts": t.get("ts")}
    return None
