"""Pulse — Real-time data dashboard backend."""
import asyncio
import json
import io
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import pandas as pd

from config import load_config, save_config, is_configured
from database import (
    init_db, save_usage_records, save_balance,
    get_usage_history, get_usage_summary, get_model_breakdown,
    get_balance_history, import_csv_data
)
from collectors.system import collect_all as collect_system_data
from collectors.deepseek import DeepseekCollector
from collectors.wmi_remote import WMIRemoteCollector

# ── Events (Lifespan) — defined before app so FastAPI can reference it ──
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: init DB + background tasks. Shutdown: cleanup."""
    await init_db()
    tasks = [
        asyncio.create_task(collect_system_loop(), name="system-loop"),
        asyncio.create_task(collect_deepseek_loop(), name="deepseek-loop"),
    ]
    print("[Pulse] Started — system@1s, deepseek@30s")
    yield
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    print("[Pulse] Shutdown complete")


# ── App Init ────────────────────────────────────────────
app = FastAPI(title="Pulse Dashboard", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── State ──────────────────────────────────────────────
config = load_config()
deepseek = DeepseekCollector(
    api_key=config.get("deepseek_api_key", ""),
    base_url=config.get("deepseek_base_url", "https://api.deepseek.com")
)
wmi_remote = WMIRemoteCollector(
    host=config.get("wmi_remote", {}).get("host", ""),
    username=config.get("wmi_remote", {}).get("username", ""),
    password=config.get("wmi_remote", {}).get("password", "")
)

# WebSocket clients
connected_clients: set[WebSocket] = set()

# Latest cached data
latest_system_data = {}
latest_deepseek_data = {
    "balance": None,
    "usage": [],
    "timestamp": None
}
daily_usage_cache = {}
net_io_prev = None


# ── Helpers ────────────────────────────────────────────
def get_daily_limit() -> dict:
    """Get configured spending limits."""
    cfg = load_config()
    return {
        "daily": cfg.get("daily_spending_limit", 5.0),
        "monthly": cfg.get("monthly_spending_limit", 100.0)
    }


def get_bytes_readable(size_bytes: int) -> str:
    """Convert bytes to human readable string."""
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} PB"


def get_uptime_readable(seconds: float) -> str:
    """Convert seconds to readable uptime."""
    days, rem = divmod(int(seconds), 86400)
    hours, rem = divmod(rem, 3600)
    mins, secs = divmod(rem, 60)
    parts = []
    if days: parts.append(f"{days}d")
    if hours: parts.append(f"{hours}h")
    if mins: parts.append(f"{mins}m")
    parts.append(f"{secs}s")
    return " ".join(parts)


# ── Background Tasks ──────────────────────────────────
async def collect_system_loop():
    """Collect system data every second and broadcast."""
    global net_io_prev
    while True:
        try:
            data = collect_system_data()

            # Calculate network speed
            net_now = data.get("network", {})
            if net_io_prev:
                data["network_speed"] = {
                    "sent_per_sec": net_now.get("bytes_sent", 0) - net_io_prev.get("bytes_sent", 0),
                    "recv_per_sec": net_now.get("bytes_recv", 0) - net_io_prev.get("bytes_recv", 0),
                }
            else:
                data["network_speed"] = {"sent_per_sec": 0, "recv_per_sec": 0}
            net_io_prev = net_now

            global latest_system_data
            latest_system_data = data

            # Broadcast to connected clients
            msg = json.dumps({"type": "system", "data": data}, default=str)
            await broadcast(msg)
        except Exception as e:
            print(f"[System] Collect error: {e}")

        await asyncio.sleep(1)


async def collect_deepseek_loop():
    """Collect Deepseek API data every 30 seconds and broadcast."""
    while True:
        try:
            if deepseek.is_ready():
                result = await deepseek.fetch_all()

                # Save to database
                if result.get("balance"):
                    await save_balance(
                        result["balance"]["balance"],
                        result["balance"].get("currency", "CNY")
                    )

                if result.get("usage"):
                    await save_usage_records(result["usage"])

                global latest_deepseek_data
                latest_deepseek_data = result

                # Build comprehensive message
                limits = get_daily_limit()
                today_summary = await get_usage_summary(days=1)
                week_summary = await get_usage_summary(days=7)
                month_summary = await get_usage_summary(days=30)
                model_breakdown = await get_model_breakdown(days=1)
                history_7d = await get_usage_history(days=7)
                balance_history = await get_balance_history(days=30)

                msg_data = {
                    "type": "deepseek",
                    "data": {
                        "balance": result.get("balance"),
                        "usage": result.get("usage", []),
                        "timestamp": result.get("timestamp"),
                        "limits": limits,
                        "today": today_summary,
                        "week": week_summary,
                        "month": month_summary,
                        "model_breakdown": model_breakdown,
                        "history_7d": history_7d,
                        "balance_history": balance_history,
                        "over_limit_daily": (
                            float(today_summary.get("total_cost", 0)) > limits["daily"]
                            if limits["daily"] > 0 else False
                        ),
                        "over_limit_monthly": (
                            float(month_summary.get("total_cost", 0)) > limits["monthly"]
                            if limits["monthly"] > 0 else False
                        ),
                    }
                }
                await broadcast(json.dumps(msg_data, default=str))
            else:
                # Broadcast config-needed status
                await broadcast(json.dumps({
                    "type": "deepseek",
                    "data": {
                        "error": "API not configured",
                        "needs_config": True,
                        "balance": None,
                        "usage": [],
                        "timestamp": datetime.now(timezone.utc).isoformat()
                    }
                }))
        except Exception as e:
            print(f"[Deepseek] Collect error: {e}")

        await asyncio.sleep(30)


async def broadcast(message: str):
    """Send message to all connected WebSocket clients."""
    if not connected_clients:
        return
    dead = set()
    for ws in connected_clients:
        try:
            await ws.send_text(message)
        except Exception:
            dead.add(ws)
    connected_clients.difference_update(dead)


# ── WebSocket ──────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_clients.add(ws)
    try:
        # Send initial data snapshot
        limits = get_daily_limit()
        # ... initial state sent via background tasks
        while True:
            try:
                data = await ws.receive_text()
                # Handle client commands
                cmd = json.loads(data)
                if cmd.get("action") == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        pass
    finally:
        connected_clients.discard(ws)


# ── REST API ──────────────────────────────────────────
@app.get("/api/status")
async def api_status():
    """Return server and config status."""
    return {
        "status": "ok",
        "deepseek_configured": deepseek.is_ready(),
        "wmi_configured": wmi_remote.is_configured(),
        "uptime": get_uptime_readable(
            (datetime.now(timezone.utc) - startup_time).total_seconds()
        )
    }


startup_time = datetime.now(timezone.utc)


@app.get("/api/deepseek/summary")
async def api_deepseek_summary():
    """Get Deepseek usage summary for today, week, month."""
    today = await get_usage_summary(1)
    week = await get_usage_summary(7)
    month = await get_usage_summary(30)
    model_brk = await get_model_breakdown(1)
    limits = get_daily_limit()
    return {
        "today": today,
        "week": week,
        "month": month,
        "model_breakdown": model_brk,
        "limits": limits,
        "over_limit_daily": (
            float(today.get("total_cost", 0)) > limits["daily"]
            if limits["daily"] > 0 else False
        ),
    }


@app.get("/api/deepseek/history")
async def api_deepseek_history(days: int = 30, model: Optional[str] = None):
    """Get historical usage data."""
    history = await get_usage_history(days=days, model=model)
    balance_hist = await get_balance_history(days=days)
    return {"usage": history, "balance_history": balance_hist}


@app.post("/api/config")
async def api_update_config(body: dict):
    """Update configuration."""
    cfg = load_config()
    # Only allow specific fields
    allowed_fields = {
        "deepseek_api_key", "deepseek_base_url",
        "daily_spending_limit", "monthly_spending_limit",
        "wmi_remote"
    }
    for key, value in body.items():
        if key in allowed_fields:
            cfg[key] = value

    save_config(cfg)

    # Update live instances
    if "deepseek_api_key" in body or "deepseek_base_url" in body:
        deepseek.api_key = cfg["deepseek_api_key"]
        deepseek.base_url = cfg.get("deepseek_base_url", "https://api.deepseek.com")

    wmi_cfg = cfg.get("wmi_remote", {})
    wmi_remote.host = wmi_cfg.get("host", "")
    wmi_remote.username = wmi_cfg.get("username", "")
    wmi_remote.password = wmi_cfg.get("password", "")

    return {"status": "ok", "configured": deepseek.is_ready()}


@app.get("/api/config")
async def api_get_config():
    """Get current config (keys masked)."""
    cfg = load_config()
    # Mask API key
    key = cfg.get("deepseek_api_key", "")
    if key and len(key) > 8:
        cfg["deepseek_api_key"] = key[:4] + "*" * (len(key) - 8) + key[-4:]
    elif key:
        cfg["deepseek_api_key"] = "***"
    return cfg


@app.post("/api/csv/import")
async def api_csv_import(file: UploadFile = File(...)):
    """Import CSV file with usage history data."""
    if not file.filename or not file.filename.endswith(".csv"):
        raise HTTPException(400, "Only CSV files are supported")

    try:
        content = await file.read()
        df = pd.read_csv(io.BytesIO(content))

        # Normalize columns — accept various naming conventions
        column_map = {
            "timestamp": ["timestamp", "date", "time", "created_at", "datetime"],
            "model": ["model", "model_id", "model_name", "engine"],
            "input_tokens": ["input_tokens", "prompt_tokens", "input", "prompt"],
            "output_tokens": ["output_tokens", "completion_tokens", "output", "completion"],
            "cached_tokens": ["cached_tokens", "cached_input_tokens", "cache_hit", "cached"],
            "total_tokens": ["total_tokens", "total", "tokens", "token_count"],
            "cost": ["cost", "cost_usd", "price", "spend", "expense"],
        }

        mapped = {}
        for target, candidates in column_map.items():
            for col in df.columns:
                if col.strip().lower() in [c.lower() for c in candidates]:
                    mapped[target] = col
                    break

        if "total_tokens" not in mapped and "input_tokens" not in mapped:
            raise HTTPException(400, "CSV must contain at least token columns (total_tokens or input_tokens)")

        # Convert to records
        records = []
        for _, row in df.iterrows():
            record = {
                "timestamp": str(row.get(mapped.get("timestamp", ""), datetime.now(timezone.utc).isoformat())),
                "model": str(row.get(mapped.get("model", ""), "imported")),
                "input_tokens": int(float(row.get(mapped.get("input_tokens", ""), 0))),
                "output_tokens": int(float(row.get(mapped.get("output_tokens", ""), 0))),
                "cached_tokens": int(float(row.get(mapped.get("cached_tokens", ""), 0))),
                "total_tokens": int(float(row.get(mapped.get("total_tokens", ""), 0))),
                "cost": float(row.get(mapped.get("cost", ""), 0.0)),
            }
            records.append(record)

        count = await import_csv_data(records, file.filename)

        return {
            "status": "ok",
            "imported": count,
            "columns_matched": list(mapped.keys()),
            "columns_unmatched": [c for c in [
                "timestamp", "model", "input_tokens", "output_tokens",
                "cached_tokens", "total_tokens", "cost"
            ] if c not in mapped]
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"CSV parse error: {str(e)}")


@app.get("/api/system/current")
async def api_system_current():
    """Get latest system data snapshot."""
    return latest_system_data or collect_system_data()


# ── Serve frontend (must come after API routes to avoid route hijacking) ──
frontend_dir = Path(__file__).parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")


# ── Entry ──────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    cfg = load_config()
    port = cfg.get("http_port", 8080)
    print(f"[Pulse] Starting on http://0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
