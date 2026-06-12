"""Rithmic connectivity adapter (prop-firm credentials: Apex, Lucid, TPT, ...).

Built against async_rithmic 1.6.x (validated against the real library API):
- RithmicClient REQUIRES a gateway URL; we default it per system and expose
  an override in the UI.
- We connect the TICKER plant only (market data) - order routing comes later.
- Front-month contracts are resolved via get_front_month_contract, then
  subscribed with LAST_TRADE | BBO; ticks arrive on client.on_tick.

REALITIES
- A live broker connection is a persistent socket: works locally or on an
  always-on host (Render blueprint included) - never on serverless (Vercel).
- Credentials are stored ONLY in data/rithmic.json on the host running
  EdgeDesk (gitignored) and are sent nowhere except Rithmic's gateway.
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
    "gateway": None,
    "ticks": {},
    "started": None,
    "stop": False,
}
_lock = threading.Lock()
_thread: threading.Thread | None = None

SYSTEMS = [
    "Rithmic Paper Trading", "Rithmic Test", "Rithmic 01",
    "Apex", "TopstepTrader", "TradeFundrr", "MES Capital", "Bulenox",
    "PropShopTrader", "4PropTrader", "FastTrackTrading", "DayTraders.com",
    "10XFutures", "LucidTrading", "ThriveTrading",
]

GATEWAYS = {
    "Chicago Area": "wss://rprotocol.rithmic.com:443",
    "Test environment": "wss://rituz00100.rithmic.com:443",
    "Europe (Frankfurt)": "wss://rprotocol-de.rithmic.com:443",
    "Asia (Singapore)": "wss://rprotocol-sg.rithmic.com:443",
}


def default_gateway(system: str) -> str:
    if "test" in (system or "").lower():
        return GATEWAYS["Test environment"]
    return GATEWAYS["Chicago Area"]


def is_serverless() -> bool:
    return bool(os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))


def lib_available() -> tuple[bool, str]:
    try:
        import async_rithmic  # noqa: F401
        return True, getattr(async_rithmic, "__version__", "installed")
    except ImportError:
        return False, ("async_rithmic is not installed. Run `pip install async_rithmic` "
                       "in the environment where EdgeDesk runs, then restart.")


def save_credentials(user: str, password: str, system: str, gateway: str) -> None:
    CREDS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CREDS_PATH.write_text(json.dumps({"user": user, "password": password,
                                      "system": system, "gateway": gateway}))
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


def _record_tick(data: dict):
    sym = str(data.get("symbol") or "?")
    with _lock:
        t = _state["ticks"].setdefault(sym, {"trades": []})
        px = data.get("trade_price")
        if px:
            t["last"] = float(px)
            t["trades"].append({"p": float(px),
                                "s": int(data.get("trade_size") or 0),
                                "ts": time.time(),
                                "side": str(data.get("aggressor") or "")})
            del t["trades"][:-400]
        if data.get("bid_price"):
            t["bid"] = float(data["bid_price"])
            t["bid_size"] = int(data.get("bid_size") or 0)
        if data.get("ask_price"):
            t["ask"] = float(data["ask_price"])
            t["ask_size"] = int(data.get("ask_size") or 0)
        t["ts"] = time.time()


def _run_client(creds: dict):
    """Background thread: own asyncio loop, persistent Rithmic connection."""
    import asyncio

    async def main():
        from async_rithmic import DataType, RithmicClient, SysInfraType
        client = RithmicClient(
            user=creds["user"], password=creds["password"],
            system_name=creds["system"],
            app_name="EdgeDesk", app_version="1.0",
            url=creds["gateway"],
        )
        await client.connect(plants=[SysInfraType.TICKER_PLANT])
        with _lock:
            _state.update(connected=True, connecting=False, error=None,
                          system=creds["system"], user=creds["user"],
                          gateway=creds["gateway"], started=time.time())

        async def on_tick(data):
            try:
                _record_tick(dict(data))
            except Exception:
                pass

        client.on_tick += on_tick

        flags = DataType.LAST_TRADE | DataType.BBO
        for root, exch in (("ES", "CME"), ("NQ", "CME"), ("CL", "NYMEX"), ("GC", "COMEX")):
            try:
                front = await client.get_front_month_contract(root, exch)
                await client.subscribe_to_market_data(front, exch, flags)
            except Exception as e:
                with _lock:
                    _state["error"] = f"subscribe {root}: {type(e).__name__}: {e}"[:200]

        while True:                                   # keep the connection alive
            await asyncio.sleep(2)
            with _lock:
                if _state["stop"]:
                    break
        try:
            await client.disconnect()
        except Exception:
            pass

    try:
        asyncio.run(main())
        with _lock:
            _state.update(connected=False, connecting=False)
    except Exception as e:
        with _lock:
            _state.update(connected=False, connecting=False,
                          error=f"{type(e).__name__}: {e}"[:300])


def connect(user: str, password: str, system: str, gateway: str | None = None) -> dict:
    if is_serverless():
        return {"ok": False, "error": (
            "Live broker connections need a persistent process and cannot run on serverless "
            "hosting. Use the included Render blueprint (always-on, free) or run EdgeDesk locally.")}
    ok, msg = lib_available()
    if not ok:
        return {"ok": False, "error": msg}
    gateway = (gateway or "").strip() or default_gateway(system)
    if "://" not in gateway:
        gateway = "wss://" + gateway
    global _thread
    with _lock:
        if _state["connecting"] or _state["connected"]:
            return {"ok": False, "error": "already connected/connecting - disconnect first"}
        _state.update(connecting=True, error=None, stop=False, gateway=gateway)
    save_credentials(user, password, system, gateway)
    _thread = threading.Thread(
        target=_run_client,
        args=({"user": user, "password": password, "system": system, "gateway": gateway},),
        daemon=True)
    _thread.start()
    return {"ok": True, "status": "connecting", "note": (
        f"Connecting to {gateway} as system '{system}'. Poll /api/rithmic/status. "
        "If login is rejected, verify the SYSTEM NAME matches exactly what your provider gave you "
        "and that this gateway region is the one your account is provisioned on.")}


def disconnect() -> dict:
    with _lock:
        _state.update(stop=True, connected=False, connecting=False)
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
            "gateway": _state["gateway"],
            "user": (_state["user"][:3] + "***") if _state["user"] else None,
            "has_saved_credentials": load_credentials() is not None,
            "uptime_s": int(time.time() - _state["started"]) if _state["started"] else None,
            "ticks": ticks,
            "systems": SYSTEMS,
            "gateways": GATEWAYS,
            "roadmap": [
                "Phase 1 (this build): credential vault + live tick/BBO feed into the quote board, DOM and order-flow pulse.",
                "Phase 2: true tick-based delta, market-depth ladder and volume profile from real prints.",
                "Phase 3: order routing - bracket orders sized by the position sizer, with journal auto-logging.",
            ],
        }


def live_quote(symbol: str) -> dict | None:
    """Best-effort live quote for board/DOM integration (root match, e.g. ES -> ESM6)."""
    with _lock:
        if not _state["connected"]:
            return None
        for sym, t in _state["ticks"].items():
            if sym.startswith(symbol) and t.get("last"):
                return {"last": t["last"], "bid": t.get("bid"), "ask": t.get("ask"),
                        "source": "rithmic", "ts": t.get("ts")}
    return None
