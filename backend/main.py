"""Pulse — Real-time data dashboard backend."""
import asyncio
import json
import io
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import pandas as pd

from config import load_config, save_config, is_configured
from database import (
    init_db, save_usage_records, save_balance,
    import_csv_data, get_usage_summary, get_usage_history, get_model_breakdown,
    get_devices, get_device, add_device, update_device, delete_device,
)
from collectors.system import collect_all as collect_system_data
from collectors.deepseek import DeepseekCollector
from collectors.wmi_remote import WMIRemoteCollector
from plugins.manager import PluginManager

# ── Events (Lifespan) — defined before app so FastAPI can reference it ──
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: init DB + init plugins + background tasks. Shutdown: cleanup."""
    await init_db()

    # Discover and init plugins
    global plugin_manager
    plugin_manager = PluginManager()
    discovered = plugin_manager.discover()
    if discovered:
        print(f"[Plugin] Discovered {len(discovered)} plugin(s):")
        for p in discovered:
            print(f"  - {p['name']} v{p['version']} (enabled: {p['enabled']})")
        await plugin_manager.init_all()
    else:
        print("[Plugin] No plugins found")

    # Link PairingManager to WebSocket clients
    lan_plugin = plugin_manager.get_plugin("LAN 设备监控")
    if lan_plugin:
        pm = await lan_plugin.get_pairing_manager(None)
        pm.set_ws_clients(connected_clients)
        # Replace db ref with actual module
        pm._db = __import__("database", fromlist=[""])
        print("[Plugin LAN] PairingManager linked to WebSocket")

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

# Plugin manager (initialized in lifespan)
plugin_manager: Optional[PluginManager] = None

# Latest cached data
latest_system_data = {}
latest_deepseek_data = {
    "balance": None,
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
    """Collect Deepseek balance every 30 seconds and broadcast.
    v2.0: usage tracking moved to manual CSV import (M3)."""
    while True:
        try:
            if deepseek.is_ready():
                result = await deepseek.fetch_all()

                # Save balance to database
                if result.get("balance"):
                    await save_balance(
                        result["balance"]["balance"],
                        result["balance"].get("currency", "CNY")
                    )

                global latest_deepseek_data
                latest_deepseek_data = result

                limits = get_daily_limit()
                msg_data = {
                    "type": "deepseek",
                    "data": {
                        "balance": result.get("balance"),
                        "timestamp": result.get("timestamp"),
                        "limits": limits,
                    }
                }
                await broadcast(json.dumps(msg_data, default=str))
            else:
                await broadcast(json.dumps({
                    "type": "deepseek",
                    "data": {
                        "error": "API not configured",
                        "needs_config": True,
                        "balance": None,
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
    return {**cfg, "configured": bool(key)}


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


# ── Device Management API ────────────────────────────────


@app.get("/api/devices")
async def api_devices_list():
    """List all configured devices."""
    return await get_devices()


@app.post("/api/devices")
async def api_devices_add(body: dict):
    """Add a new device. Requires name and host."""
    name = body.get("name", "").strip()
    host = body.get("host", "").strip()
    if not name or not host:
        raise HTTPException(400, "name and host are required")
    device_id = await add_device(
        name=name,
        host=host,
        username=body.get("username", ""),
        password=body.get("password", ""),
        port=int(body.get("port", 135)),
        enabled=int(body.get("enabled", 1)),
    )
    device = await get_device(device_id)
    return {"status": "ok", "device": device}


@app.put("/api/devices/{device_id}")
async def api_devices_update(device_id: int, body: dict):
    """Update device fields."""
    existing = await get_device(device_id)
    if not existing:
        raise HTTPException(404, "Device not found")
    ok = await update_device(device_id, body)
    device = await get_device(device_id)
    return {"status": "ok" if ok else "no_change", "device": device}


@app.delete("/api/devices/{device_id}")
async def api_devices_delete(device_id: int):
    """Delete a device."""
    existing = await get_device(device_id)
    if not existing:
        raise HTTPException(404, "Device not found")
    ok = await delete_device(device_id)
    return {"status": "ok" if ok else "not_found"}


@app.post("/api/devices/{device_id}/test")
async def api_devices_test(device_id: int):
    """Test WMI connection to a device."""
    device = await get_device(device_id)
    if not device:
        raise HTTPException(404, "Device not found")
    try:
        from collectors.wmi_remote import WMIRemoteCollector
        tester = WMIRemoteCollector(
            host=device["host"],
            username=device.get("username", ""),
            password=device.get("password", "")
        )
        result = await tester.test_connection()
        return {"status": "ok", "result": result}
    except Exception as e:
        raise HTTPException(502, f"WMI connection failed: {str(e)}")


# ── Plugin API ─────────────────────────────────────────────


@app.get("/api/plugins")
async def api_plugins_list():
    """List all discovered plugins with their status."""
    if plugin_manager is None:
        return []
    return plugin_manager.get_all_status()


@app.post("/api/plugins/{name}/enable")
async def api_plugin_enable(name: str):
    """Enable a plugin by its human-readable name."""
    if plugin_manager is None:
        raise HTTPException(503, "Plugin manager not ready")
    ok = await plugin_manager.enable(name)
    if not ok:
        raise HTTPException(400, f"Failed to enable plugin '{name}' — already enabled or not found")
    return {"status": "ok", "enabled": True}


@app.post("/api/plugins/{name}/disable")
async def api_plugin_disable(name: str):
    """Disable a plugin by its human-readable name."""
    if plugin_manager is None:
        raise HTTPException(503, "Plugin manager not ready")
    ok = await plugin_manager.disable(name)
    if not ok:
        raise HTTPException(400, f"Failed to disable plugin '{name}' — already disabled or not found")
    return {"status": "ok", "enabled": False}


# ── LAN (Paired Devices) API ──────────────────────────────


def _lan_plugin_check():
    """Check if LAN monitor plugin is enabled. Raises 403 if not."""
    if plugin_manager is None:
        raise HTTPException(503, "Plugin manager not ready")
    lan_plugin = plugin_manager.get_plugin("LAN 设备监控")
    if lan_plugin is None:
        raise HTTPException(404, "LAN 设备监控 plugin not found")
    if not lan_plugin.enabled:
        raise HTTPException(403, "LAN 设备监控 plugin is disabled")
    return lan_plugin


def _get_pairing_manager():
    """Get the PairingManager from the LAN plugin."""
    lan_plugin = _lan_plugin_check()
    pm = getattr(lan_plugin, "_pairing_manager", None)
    if pm is None:
        # Create one on-demand if not yet created
        from plugins.lan_monitor.pairing import PairingManager
        import database as db_mod
        pm = PairingManager(db_mod)
        pm.set_ws_clients(connected_clients)
        lan_plugin._pairing_manager = pm
    return pm


@app.post("/api/lan/discover")
async def api_lan_discover(timeout: float = 5.0):
    """Send UDP broadcast and return discovered devices.

    Note: UDP discovery only works in real LAN environments.
    On single-device setups this will return an empty list.
    Use self-pair for testing.
    """
    lan_plugin = _lan_plugin_check()
    try:
        devices = await lan_plugin.scan_network(timeout=timeout)
        return {"status": "ok", "devices": devices}
    except Exception as e:
        raise HTTPException(502, f"Discovery failed: {str(e)}")


@app.post("/api/lan/pair-request")
async def api_lan_pair_request(body: dict):
    """Request pairing with a discovered device."""
    ip = body.get("ip", "").strip()
    name = body.get("name", "").strip()
    if not ip:
        raise HTTPException(400, "ip is required")

    pm = _get_pairing_manager()
    result = await pm.request_pair(ip, name)
    return result


@app.post("/api/lan/pair-approve")
async def api_lan_pair_approve(body: dict):
    """Approve a pending pairing request."""
    token = body.get("token", "").strip()
    if not token:
        raise HTTPException(400, "token is required")

    persistent = body.get("persistent", False)
    pin = body.get("pin", "")

    pm = _get_pairing_manager()
    result = await pm.approve_pair(token, persistent=persistent, pin=pin)
    if result.get("status") == "error":
        raise HTTPException(400, result.get("message", "Approval failed"))
    return result


@app.post("/api/lan/pair-reject")
async def api_lan_pair_reject(body: dict):
    """Reject a pending pairing request."""
    token = body.get("token", "").strip()
    if not token:
        raise HTTPException(400, "token is required")

    pm = _get_pairing_manager()
    result = await pm.reject_pair(token)
    return result


@app.post("/api/lan/unpair")
async def api_lan_unpair(body: dict):
    """Unpair (disconnect) a paired device."""
    device_id = body.get("device_id")
    if device_id is None:
        raise HTTPException(400, "device_id is required")

    pm = _get_pairing_manager()
    ok = await pm.unpair(int(device_id))
    return {"status": "ok" if ok else "not_found"}


@app.get("/api/lan/devices")
async def api_lan_devices_list():
    """List all paired LAN devices."""
    # Check plugin is enabled (but don't require it for viewing)
    # Allow viewing even when disabled for configuration purposes
    try:
        pm = _get_pairing_manager()
    except HTTPException:
        # Plugin disabled — return empty list
        return []
    return await pm.get_paired_devices()


@app.put("/api/lan/devices/{device_id}/metrics")
async def api_lan_device_update_metrics(device_id: int, body: dict):
    """Update shared metrics for a paired device."""
    metrics = body.get("metrics", "").strip()
    if not metrics:
        raise HTTPException(400, "metrics is required (comma-separated, e.g. 'cpu,memory,disk')")

    pm = _get_pairing_manager()
    ok = await pm.update_metrics(device_id, metrics)
    if not ok:
        raise HTTPException(404, "Device not found")
    return {"status": "ok"}


@app.post("/api/lan/self-pair")
async def api_lan_self_pair():
    """Self-pair for localhost testing.

    Auto-pairs the local device without UDP discovery.
    Only works when LAN plugin is enabled.
    """
    lan_plugin = _lan_plugin_check()
    pm = getattr(lan_plugin, "_pairing_manager", None)
    if pm is None:
        from plugins.lan_monitor.pairing import PairingManager
        import database as db_mod
        pm = PairingManager(db_mod)
        pm.set_ws_clients(connected_clients)
        lan_plugin._pairing_manager = pm
    result = await pm.self_pair()
    return result


@app.get("/api/lan/pending-requests")
async def api_lan_pending_requests():
    """Get list of pending pairing requests."""
    pm = _get_pairing_manager()
    return {"requests": pm.get_pending_requests()}


# ── Analysis API (re-imported from original) ──────────────


@app.get("/api/analysis/summary")
async def api_analysis_summary(days: int = 30):
    """Get aggregated usage summary for the last N days."""
    days = min(days, 365)
    try:
        return await get_usage_summary(days)
    except Exception as e:
        raise HTTPException(500, f"Failed to get summary: {str(e)}")


@app.get("/api/analysis/history")
async def api_analysis_history(days: int = 30, model: Optional[str] = None):
    """Get usage history for the last N days, optionally filtered by model."""
    days = min(days, 365)
    try:
        return await get_usage_history(days, model)
    except Exception as e:
        raise HTTPException(500, f"Failed to get history: {str(e)}")


@app.get("/api/analysis/models")
async def api_analysis_models(days: int = 30):
    """Get per-model breakdown for the last N days."""
    days = min(days, 365)
    try:
        return await get_model_breakdown(days)
    except Exception as e:
        raise HTTPException(500, f"Failed to get models: {str(e)}")


# ── Serve frontend (catch-all at end, after all API+WS routes) ──
# Note: NOT using app.mount() because it intercepts ALL paths including /ws.
# Instead, a catch-all GET route serves static files while allowing WebSocket
# and API routes to match first via normal route resolution order.
frontend_dir = Path(__file__).parent.parent / "frontend"

@app.get("/{path:path}", include_in_schema=False)
async def serve_frontend(path: str):
    file_path = frontend_dir / path
    if file_path.exists() and file_path.is_file():
        return FileResponse(file_path)
    return FileResponse(frontend_dir / "index.html")


# ── Entry ──────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    cfg = load_config()
    port = cfg.get("http_port", 8080)
    print(f"[Pulse] Starting on http://0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
