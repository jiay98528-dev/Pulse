"""Pulse — Real-time data dashboard backend."""
import asyncio
import json
import io
import os
import shutil
import subprocess
import threading
import time
import webbrowser
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlparse

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11 fallback.
    tomllib = None

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import pandas as pd

from config import load_config, save_config, is_configured
from database import (
    init_db, save_balance,
    import_csv_data, get_usage_summary, get_usage_history, get_model_breakdown,
    get_devices, get_device, add_device, update_device, delete_device,
)
from collectors.system import collect_all as collect_system_data
from collectors.deepseek import DeepseekCollector
from collectors.wmi_remote import WMIRemoteCollector
from plugins.manager import PluginManager

try:
    from runtime_paths import get_frontend_dir
except ImportError:  # Allows package-style imports in smoke tests.
    from .runtime_paths import get_frontend_dir

# ── Events (Lifespan) — defined before app so FastAPI can reference it ──
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: init DB + init plugins + background tasks. Shutdown: cleanup."""
    await init_db()

    global startup_time
    startup_time = datetime.now(timezone.utc)

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

ALLOWED_ORIGINS = [
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
]


def is_allowed_origin(origin: str) -> bool:
    """Allow local browser/Tauri origins while rejecting remote write origins."""
    if not origin:
        return True
    if origin in ALLOWED_ORIGINS:
        return True
    parsed = urlparse(origin)
    return parsed.scheme in {"http", "https"} and parsed.hostname in {"127.0.0.1", "localhost"}


app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def reject_untrusted_write_origins(request: Request, call_next):
    """Reject browser writes from non-local origins before they reach API handlers."""
    if request.url.path.startswith("/api/") and request.method not in {"GET", "HEAD", "OPTIONS"}:
        origin = request.headers.get("origin")
        if origin and not is_allowed_origin(origin):
            return JSONResponse({"detail": "Origin not allowed"}, status_code=403)
    return await call_next(request)

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

# Server start time (set in lifespan)
startup_time: Optional[datetime] = None

# Latest cached data
latest_system_data = {}
latest_deepseek_data = {
    "balance": None,
    "timestamp": None
}
daily_usage_cache = {}
net_io_prev = None

CODEX_CLI_TIMEOUT_SECONDS = 2
CODEX_LOGIN_TIMEOUT_SECONDS = 2
CODEX_DOCTOR_TIMEOUT_SECONDS = 6
CODEX_DOCTOR_CACHE_TTL_SECONDS = 120
CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage"
CODEX_USAGE_HELP_URL = "https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan"
_codex_doctor_lock = threading.Lock()
_codex_doctor_cache = {
    "cli_path": "",
    "timestamp": 0.0,
    "data": None,
    "refreshing": False,
}


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


def _bool_from_codex_detail(value) -> bool:
    """Codex doctor returns redacted detail values as strings."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "1", "ok"}
    return bool(value)


def _find_nested_value(data, target_key: str):
    """Find a key inside parsed TOML without exposing neighboring auth values."""
    if not isinstance(data, dict):
        return None
    if target_key in data:
        return data[target_key]
    for value in data.values():
        found = _find_nested_value(value, target_key)
        if found:
            return found
    return None


def _iter_codex_cli_candidates():
    """Yield known Codex CLI candidate paths without reading auth storage."""
    env_path = os.environ.get("CODEX_CLI_PATH")
    if env_path:
        yield env_path, "CODEX_CLI_PATH"

    config_path = Path.home() / ".codex" / "config.toml"
    if tomllib and config_path.exists():
        try:
            parsed = tomllib.loads(config_path.read_text(encoding="utf-8"))
            configured_path = _find_nested_value(parsed, "CODEX_CLI_PATH")
            if configured_path:
                yield str(configured_path), "codex_config"
        except Exception:
            pass

    path_candidate = shutil.which("codex")
    if path_candidate:
        yield path_candidate, "PATH"


def _normalize_cli_path(raw_path: str) -> Optional[Path]:
    if not raw_path:
        return None
    cleaned = str(raw_path).strip().strip('"').strip("'")
    expanded = os.path.expandvars(os.path.expanduser(cleaned))
    try:
        return Path(expanded)
    except Exception:
        return None


def _codex_creation_flags() -> int:
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def _short_codex_error(exc: Exception) -> str:
    message = str(exc).replace("\r", " ").replace("\n", " ").strip()
    return (message[:180] + "...") if len(message) > 180 else message


def _run_codex_command(cli_path: Path, args: list[str], timeout: int) -> dict:
    try:
        proc = subprocess.run(
            [str(cli_path), *args],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=_codex_creation_flags(),
        )
        return {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "stdout": proc.stdout or "",
            "stderr": proc.stderr or "",
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "returncode": None, "stdout": "", "stderr": "timeout"}
    except Exception as exc:
        return {"ok": False, "returncode": None, "stdout": "", "stderr": _short_codex_error(exc)}


def _detect_codex_cli() -> dict:
    seen: set[str] = set()
    last_error = ""
    for raw_path, source in _iter_codex_cli_candidates():
        cli_path = _normalize_cli_path(raw_path)
        if not cli_path:
            continue
        key = str(cli_path).lower()
        if key in seen:
            continue
        seen.add(key)
        version_result = _run_codex_command(cli_path, ["--version"], timeout=CODEX_CLI_TIMEOUT_SECONDS)
        if version_result["ok"]:
            version = version_result["stdout"].strip() or "unknown"
            return {
                "available": True,
                "path": cli_path,
                "source": source,
                "version": version,
            }
        last_error = version_result["stderr"] or f"exit {version_result['returncode']}"

    return {
        "available": False,
        "path": None,
        "source": None,
        "version": "",
        "error": last_error or "Codex CLI not found",
    }


def _codex_doctor_patch_from_report(report: dict, returncode) -> dict:
    checks = report.get("checks") or {}
    auth_check = checks.get("auth.credentials") or {}
    auth_details = auth_check.get("details") or {}
    app_check = checks.get("app_server.status") or {}
    app_details = app_check.get("details") or {}
    return {
        "doctor": {
            "status": "ok",
            "ok": True,
            "returncode": returncode,
            "overall_status": report.get("overallStatus", "unknown"),
        },
        "cli": {
            "version": report.get("codexVersion") or "",
        },
        "auth": {
            "configured": auth_check.get("status") == "ok",
            "mode": str(auth_details.get("stored auth mode") or ""),
            "stored_api_key": _bool_from_codex_detail(auth_details.get("stored API key")),
            "stored_chatgpt_tokens": _bool_from_codex_detail(auth_details.get("stored ChatGPT tokens")),
        },
        "app_server": {
            "status": str(app_details.get("status") or app_check.get("status") or "unknown"),
            "summary": str(app_check.get("summary") or ""),
        },
    }


def _collect_codex_doctor_patch(cli_path: Path) -> dict:
    doctor = _run_codex_command(cli_path, ["doctor", "--json"], timeout=CODEX_DOCTOR_TIMEOUT_SECONDS)
    if not doctor["stdout"]:
        return {
            "doctor": {
                "status": "timeout" if doctor["stderr"] == "timeout" else "error",
                "ok": False,
                "returncode": doctor["returncode"],
                "error": doctor["stderr"] or "Codex doctor returned no output",
            }
        }
    try:
        report = json.loads(doctor["stdout"])
    except json.JSONDecodeError:
        return {
            "doctor": {
                "status": "error",
                "ok": False,
                "returncode": doctor["returncode"],
                "error": "Codex doctor returned invalid JSON",
            }
        }
    return _codex_doctor_patch_from_report(report, doctor["returncode"])


def _merge_codex_doctor_patch(result: dict, patch: dict, status_override: Optional[str] = None) -> None:
    if not patch:
        return
    doctor = dict(patch.get("doctor") or {})
    if status_override:
        doctor["previous_status"] = doctor.get("status", "unknown")
        doctor["status"] = status_override
    result["doctor"] = doctor
    cli_version = (patch.get("cli") or {}).get("version")
    if cli_version:
        result["cli"]["version"] = cli_version
    if "auth" in patch:
        result["auth"] = patch["auth"]
    if "app_server" in patch:
        result["app_server"] = patch["app_server"]


def _refresh_codex_doctor_cache(cli_path: Path) -> None:
    try:
        patch = _collect_codex_doctor_patch(cli_path)
    except Exception as exc:
        patch = {
            "doctor": {
                "status": "error",
                "ok": False,
                "returncode": None,
                "error": _short_codex_error(exc),
            }
        }
    with _codex_doctor_lock:
        _codex_doctor_cache.update({
            "cli_path": str(cli_path),
            "timestamp": time.monotonic(),
            "data": patch,
            "refreshing": False,
        })


def _get_or_start_codex_doctor(cli_path: Path) -> tuple[Optional[dict], str, float]:
    now = time.monotonic()
    with _codex_doctor_lock:
        same_cli = _codex_doctor_cache.get("cli_path") == str(cli_path)
        data = _codex_doctor_cache.get("data") if same_cli else None
        age = now - float(_codex_doctor_cache.get("timestamp") or 0)
        fresh = bool(data) and age <= CODEX_DOCTOR_CACHE_TTL_SECONDS
        if fresh:
            return data, "cached", age
        if not _codex_doctor_cache.get("refreshing"):
            _codex_doctor_cache.update({
                "cli_path": str(cli_path),
                "refreshing": True,
            })
            thread = threading.Thread(target=_refresh_codex_doctor_cache, args=(cli_path,), daemon=True)
            thread.start()
        if data:
            return data, "cached", age
    return None, "pending", 0.0


def _build_codex_status() -> dict:
    """Return a redacted local Codex status. No auth files or tokens are read."""
    detected = _detect_codex_cli()
    result = {
        "status": "ok",
        "available": bool(detected["available"]),
        "cli": {
            "available": bool(detected["available"]),
            "version": detected.get("version", ""),
            "source": detected.get("source"),
        },
        "auth": {
            "configured": False,
            "mode": "",
            "stored_api_key": False,
            "stored_chatgpt_tokens": False,
        },
        "app_server": {
            "status": "unknown",
            "summary": "",
        },
        "quota": {
            "available": False,
            "message": "Codex 订阅额度不能通过 OpenAI API Key 查询；请在 Codex Settings > Usage 或活跃 CLI 会话 /status 查看。",
            "usage_url": CODEX_USAGE_URL,
            "help_url": CODEX_USAGE_HELP_URL,
        },
    }
    if not detected["available"]:
        result["status"] = "unavailable"
        result["error"] = detected.get("error", "Codex CLI not found")
        result["doctor"] = {"status": "unavailable", "ok": False}
        return result

    _apply_codex_login_status(result, detected["path"])
    patch, doctor_state, age = _get_or_start_codex_doctor(detected["path"])
    if patch:
        _merge_codex_doctor_patch(result, patch, "cached" if doctor_state == "cached" else None)
        result["doctor"]["cache_age_seconds"] = round(age, 1)
    else:
        result["doctor"] = {
            "status": "pending",
            "ok": False,
            "message": "Codex doctor is refreshing in the background",
        }
    return result


def _apply_codex_login_status(result: dict, cli_path: Path) -> None:
    login = _run_codex_command(cli_path, ["login", "status"], timeout=CODEX_LOGIN_TIMEOUT_SECONDS)
    result["auth_probe"] = {"ok": bool(login["ok"])}
    text = ((login["stdout"] or "") + "\n" + (login["stderr"] or "")).strip().lower()
    if not login["ok"]:
        return
    if "logged in" in text:
        result["auth"]["configured"] = True
        if "chatgpt" in text:
            result["auth"]["mode"] = "chatgpt"
            result["auth"]["stored_chatgpt_tokens"] = True
        elif "api key" in text or "api-key" in text:
            result["auth"]["mode"] = "api_key"
            result["auth"]["stored_api_key"] = True
    elif "not logged" in text or "not authenticated" in text:
        result["auth"]["configured"] = False


def _launch_codex_app() -> dict:
    detected = _detect_codex_cli()
    if not detected["available"]:
        return {"status": "unavailable", "error": detected.get("error", "Codex CLI not found")}
    try:
        subprocess.Popen(
            [str(detected["path"]), "app"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_codex_creation_flags(),
        )
        return {"status": "ok"}
    except Exception as exc:
        return {"status": "error", "error": _short_codex_error(exc)}


def _open_codex_usage_page() -> dict:
    try:
        opened = webbrowser.open(CODEX_USAGE_URL, new=2, autoraise=True)
        if not opened:
            return {"status": "error", "error": "Default browser refused the URL"}
        return {"status": "ok", "url": CODEX_USAGE_URL}
    except Exception as exc:
        return {"status": "error", "error": _short_codex_error(exc)}


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
                today_summary = await get_usage_summary(1)
                month_summary = await get_usage_summary(30)
                msg_data = {
                    "type": "deepseek",
                    "data": {
                        "balance": result.get("balance"),
                        "timestamp": result.get("timestamp"),
                        "limits": limits,
                        "today_cost": today_summary.get("total_cost", 0),
                        "month_cost": month_summary.get("total_cost", 0),
                        "input_tokens": today_summary.get("total_input", 0),
                        "output_tokens": today_summary.get("total_output", 0),
                        "cached_tokens": today_summary.get("total_cached", 0),
                        "total_tokens": today_summary.get("total_tokens", 0),
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
    origin = ws.headers.get("origin", "")
    if origin and not is_allowed_origin(origin):
        await ws.close(code=4003, reason="Origin not allowed")
        return
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



@app.post("/api/config")
async def api_update_config(body: dict):
    """Update configuration."""
    cfg = load_config()
    # Only allow specific fields
    allowed_fields = {
        "ai_provider",
        "deepseek_api_key", "deepseek_base_url",
        "openai_api_key", "openai_base_url",
        "anthropic_api_key", "anthropic_base_url",
        "daily_spending_limit", "monthly_spending_limit",
        "wmi_remote"
    }
    for key, value in body.items():
        if key in allowed_fields:
            if key.endswith("_api_key") and isinstance(value, str) and not value.strip():
                continue
            if key == "ai_provider" and value not in {"deepseek", "openai", "anthropic"}:
                raise HTTPException(400, "Unsupported AI provider")
            if key == "wmi_remote" and not isinstance(value, dict):
                raise HTTPException(400, "wmi_remote must be an object/dict")
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

    return {"status": "ok", "configured": is_configured()}


@app.get("/api/config")
async def api_get_config():
    """Get current config (keys masked)."""
    cfg = load_config()
    cfg.pop("lan_trust_pin", None)
    provider = cfg.get("ai_provider", "deepseek")
    configured_providers = {}
    for name in ("deepseek", "openai", "anthropic"):
        field = f"{name}_api_key"
        key = cfg.get(field, "")
        configured_providers[name] = bool(key and key.strip())
        if key and len(key) > 8:
            cfg[field] = key[:4] + "*" * (len(key) - 8) + key[-4:]
        elif key:
            cfg[field] = "***"
    wmi_remote_cfg = cfg.get("wmi_remote")
    if isinstance(wmi_remote_cfg, dict):
        wmi_remote_cfg = dict(wmi_remote_cfg)
        password = wmi_remote_cfg.get("password", "")
        wmi_remote_cfg["password"] = "***" if password else ""
        wmi_remote_cfg["password_configured"] = bool(password)
        cfg["wmi_remote"] = wmi_remote_cfg
    return {
        **cfg,
        "configured": configured_providers.get(provider, False),
        "configured_providers": configured_providers,
        "lan_trust_pin_configured": bool(load_config().get("lan_trust_pin", "")),
    }


@app.get("/api/health")
async def api_health():
    """Lightweight readiness probe for release smoke tests."""
    return {
        "status": "ok",
        "configured": is_configured(),
        "plugin_manager": plugin_manager is not None,
    }


@app.get("/api/integrations/codex/status")
async def api_codex_status():
    """Report local Codex installation/auth status without exposing credentials."""
    return await asyncio.to_thread(_build_codex_status)


@app.post("/api/integrations/codex/open")
async def api_codex_open():
    """Open the local Codex desktop app via the installed CLI."""
    result = await asyncio.to_thread(_launch_codex_app)
    if result.get("status") == "unavailable":
        raise HTTPException(404, result.get("error", "Codex CLI not found"))
    if result.get("status") != "ok":
        raise HTTPException(500, result.get("error", "Failed to launch Codex"))
    return result


@app.post("/api/integrations/codex/open-usage")
async def api_codex_open_usage():
    """Open the official Codex usage page. The URL is fixed server-side."""
    result = await asyncio.to_thread(_open_codex_usage_page)
    if result.get("status") != "ok":
        raise HTTPException(500, result.get("error", "Failed to open Codex usage page"))
    return result


CSV_COLUMN_MAP = {
    "timestamp": ["timestamp", "date", "utc_date", "time", "created_at", "datetime", "日期", "时间"],
    "model": ["model", "model_id", "model_name", "engine", "模型"],
    "input_tokens": ["input_tokens", "prompt_tokens", "input", "prompt", "输入token", "输入 tokens", "amount"],
    "output_tokens": ["output_tokens", "completion_tokens", "output", "completion", "输出token", "输出 tokens"],
    "cached_tokens": ["cached_tokens", "cached_input_tokens", "cache_hit", "cached", "缓存token", "缓存 tokens"],
    "total_tokens": ["total_tokens", "total", "tokens", "token_count", "总token", "总 tokens"],
    "cost": ["cost", "cost_usd", "price", "spend", "expense", "费用", "消费"],
}


def _safe_number(value, default=0.0) -> float:
    """Convert spreadsheet cells to float while treating blank/NaN as default."""
    if value is None or pd.isna(value):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _records_from_dataframe(df: pd.DataFrame) -> tuple[list[dict], set[str], set[str]]:
    """Normalize one usage dataframe to database records."""
    mapped = {}
    normalized = {str(col).strip().lower(): col for col in df.columns}
    for target, candidates in CSV_COLUMN_MAP.items():
        for candidate in candidates:
            col = normalized.get(candidate.lower())
            if col is not None:
                mapped[target] = col
                break

    if "total_tokens" not in mapped and "input_tokens" not in mapped:
        if not ("cost" in mapped and "timestamp" in mapped):
            raise HTTPException(400, "CSV must contain at least token columns (total_tokens or input_tokens)")
        # Deepseek cost-only CSV: accept with 0 tokens

    records = []
    now = datetime.now(timezone.utc).isoformat()
    for _, row in df.iterrows():
        input_tokens = int(_safe_number(row.get(mapped.get("input_tokens", ""), 0)))
        output_tokens = int(_safe_number(row.get(mapped.get("output_tokens", ""), 0)))
        total_tokens = int(_safe_number(row.get(mapped.get("total_tokens", ""), input_tokens + output_tokens)))
        if total_tokens <= 0:
            total_tokens = input_tokens + output_tokens
        timestamp = row.get(mapped.get("timestamp", ""), now)
        if timestamp is None or pd.isna(timestamp):
            timestamp = now
        model = row.get(mapped.get("model", ""), "imported")
        if model is None or pd.isna(model):
            model = "imported"
        records.append({
            "timestamp": str(timestamp),
            "model": str(model),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_tokens": int(_safe_number(row.get(mapped.get("cached_tokens", ""), 0))),
            "total_tokens": total_tokens,
            "cost": _safe_number(row.get(mapped.get("cost", ""), 0.0)),
        })

    return records, set(mapped.keys()), set(CSV_COLUMN_MAP.keys()) - set(mapped.keys())


def _pivot_deepseek_amount_df(df: pd.DataFrame) -> pd.DataFrame:
    """Detect and pivot Deepseek amount CSV (long format: type+amount columns).
    Returns the original df if not the Deepseek format."""
    # Check if this is a Deepseek amount CSV: has 'type' column with known values
    cols_lower = {c.strip().lower() for c in df.columns}
    if 'type' not in cols_lower:
        return df
    type_col = [c for c in df.columns if c.strip().lower() == 'type'][0]
    type_vals = set(df[type_col].dropna().unique())
    known_types = {'input_cache_hit_tokens', 'input_cache_miss_tokens', 'output_tokens', 'total_tokens', 'request_count'}
    if not (type_vals & known_types):
        return df  # Not a Deepseek amount CSV

    # Pivot: group by (utc_date/date, model), pivot type->amount
    date_col = None
    for candidate in ['utc_date', 'date', 'timestamp']:
        for col in df.columns:
            if col.strip().lower() == candidate:
                date_col = col
                break
        if date_col:
            break
    model_col = None
    for candidate in ['model', 'model_name']:
        for col in df.columns:
            if col.strip().lower() == candidate:
                model_col = col
                break
        if model_col:
            break
    amount_col = None
    for candidate in ['amount']:
        for col in df.columns:
            if col.strip().lower() == candidate:
                amount_col = col
                break
        if amount_col:
            break

    if not date_col or not model_col or not amount_col:
        return df

    # Pivot: aggregate by date+model+type
    grouped = df.groupby([date_col, model_col, type_col])[amount_col].sum().unstack(fill_value=0)
    grouped = grouped.reset_index()
    grouped.columns = [str(c).strip() for c in grouped.columns]

    # Rename to our standard columns
    rename_map = {}
    for col in grouped.columns:
        cl = col.lower().replace(' ', '_')
        if 'cache_hit' in cl or 'cached_hit' in cl:
            rename_map[col] = 'cached_tokens'
        elif 'cache_miss' in cl:
            rename_map[col] = 'input_tokens'
        elif 'output_tokens' in cl and 'total' not in cl:
            rename_map[col] = 'output_tokens'
        elif cl == 'total_tokens':
            rename_map[col] = 'total_tokens'
    grouped.rename(columns=rename_map, inplace=True)

    # Ensure total_tokens = sum of all types
    token_cols = [c for c in grouped.columns if c not in (date_col, model_col, 'request_count')]
    if 'total_tokens' not in grouped.columns and token_cols:
        grouped['total_tokens'] = grouped[token_cols].sum(axis=1)

    # Rename date/model to standard names
    date_rename = {date_col: 'timestamp', model_col: 'model'}
    grouped.rename(columns=date_rename, inplace=True)

    return grouped


def _annotate_records(records: list, source_file: str, imported_at: str):
    """Attach source metadata to each record in-place."""
    for r in records:
        r["source_file"] = source_file
        r["imported_at"] = imported_at


MAX_CSV_SIZE = 50 * 1024 * 1024  # 50MB
MAX_THEME_PACKAGE_SIZE = 10 * 1024 * 1024  # 10MB
_csv_import_semaphore = asyncio.Semaphore(3)


@app.post("/api/csv/import")
async def api_csv_import(file: UploadFile = File(...)):
    """Import CSV or ZIP usage history data."""
    if not file.filename:
        raise HTTPException(400, "A .csv or .zip file is required")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in {".csv", ".zip"}:
        raise HTTPException(400, "Only CSV and ZIP files are supported")

    async with _csv_import_semaphore:
        try:
            content = await file.read()
            if len(content) > MAX_CSV_SIZE:
                raise HTTPException(413, f"File too large (max {MAX_CSV_SIZE // (1024*1024)}MB)")
            records = []
            matched: set[str] = set()
            unmatched: set[str] = set(CSV_COLUMN_MAP.keys())
            parsed_files = []
            imported_at = datetime.now(timezone.utc).isoformat()

            if suffix == ".csv":
                df = pd.read_csv(io.BytesIO(content))
                df = _pivot_deepseek_amount_df(df)
                parsed, file_matched, file_unmatched = _records_from_dataframe(df)
                _annotate_records(parsed, file.filename, imported_at)
                records.extend(parsed)
                matched.update(file_matched)
                unmatched.intersection_update(file_unmatched)
                parsed_files.append(file.filename)
            else:
                with zipfile.ZipFile(io.BytesIO(content)) as zf:
                    csv_names = [name for name in zf.namelist() if name.lower().endswith(".csv")]
                    if not csv_names:
                        raise HTTPException(400, "ZIP must contain at least one CSV file")
                    for name in csv_names:
                        with zf.open(name) as csv_file:
                            df = pd.read_csv(csv_file)
                            df = _pivot_deepseek_amount_df(df)
                        parsed, file_matched, file_unmatched = _records_from_dataframe(df)
                        _annotate_records(parsed, Path(name.replace("\\", "/")).name, imported_at)
                        records.extend(parsed)
                        matched.update(file_matched)
                        unmatched.intersection_update(file_unmatched)
                        parsed_files.append(name)

            count = await import_csv_data(records, file.filename)

            return {
                "status": "ok",
                "imported": count,
                "records_seen": len(records),
                "files_parsed": parsed_files,
                "columns_matched": sorted(matched),
                "columns_unmatched": sorted(unmatched),
            }

        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(400, f"CSV parse error: {str(e)}")


def _find_in_zip(names: dict, filename: str):
    """Find a file in normalized zip name dict, trying exact match then path suffix."""
    name = names.get(filename)
    if name:
        return name
    return next((orig for norm, orig in names.items() if norm.endswith(f"/{filename}")), None)


@app.post("/api/theme/import")
async def api_theme_import(file: UploadFile = File(...)):
    """Import a .pulse-theme ZIP package and return its theme payload."""
    if not file.filename:
        raise HTTPException(400, "A .pulse-theme file is required")
    if Path(file.filename).suffix.lower() != ".pulse-theme":
        raise HTTPException(400, "Only .pulse-theme packages are supported")

    content = await file.read()
    if len(content) > MAX_THEME_PACKAGE_SIZE:
        raise HTTPException(413, f"Theme package too large (max {MAX_THEME_PACKAGE_SIZE // (1024*1024)}MB)")

    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            names = {name.replace("\\", "/"): name for name in zf.namelist()}
            theme_name = _find_in_zip(names, "theme.json")
            if not theme_name:
                raise HTTPException(400, "Theme package must contain theme.json")

            if zf.getinfo(theme_name).file_size > 1024 * 1024:
                raise HTTPException(413, "theme.json is too large")
            with zf.open(theme_name) as theme_file:
                theme = json.loads(theme_file.read().decode("utf-8-sig"))

            css_name = _find_in_zip(names, "custom.css")
            if css_name:
                if zf.getinfo(css_name).file_size > 256 * 1024:
                    raise HTTPException(413, "custom.css is too large")
                with zf.open(css_name) as css_file:
                    theme["customCSS"] = css_file.read().decode("utf-8-sig")
    except HTTPException:
        raise
    except zipfile.BadZipFile:
        raise HTTPException(400, "Invalid .pulse-theme ZIP package")
    except Exception as e:
        raise HTTPException(400, f"Theme import error: {str(e)}")

    if not isinstance(theme, dict) or not isinstance(theme.get("tokens"), dict):
        raise HTTPException(400, "theme.json must include a tokens object")

    theme.setdefault("id", Path(file.filename).stem)
    theme.setdefault("name", theme["id"])
    theme.setdefault("author", "Local")
    theme.setdefault("type", "custom")
    return {"status": "ok", "theme": theme}


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
    devices = await pm.get_paired_devices()
    now = datetime.now(timezone.utc).isoformat()
    local_snapshot = latest_system_data or collect_system_data()
    for device in devices:
        device.setdefault("online", False)
        device.setdefault("last_seen", device.get("created_at") or "")
        if device.get("device_id") == "self":
            device["online"] = True
            device["last_seen"] = now
            device["metrics"] = normalize_lan_metrics(local_snapshot)
    return devices


def normalize_lan_metrics(snapshot: dict) -> dict:
    """Map local system collector output to the LAN peer metric contract."""
    memory = snapshot.get("memory") or {}
    network = snapshot.get("network_speed") or {}
    gpu_list = snapshot.get("gpu") or []
    gpu = gpu_list[0] if isinstance(gpu_list, list) and gpu_list else {}
    battery = snapshot.get("battery") or {}
    return {
        "cpu": snapshot.get("cpu") or {},
        "memory": memory,
        "disk": snapshot.get("disk") or [],
        "network": {
            "recv_bytes_per_sec": network.get("recv_per_sec", 0),
            "sent_bytes_per_sec": network.get("sent_per_sec", 0),
        },
        "gpu": gpu,
        "battery": battery,
        "processes": snapshot.get("processes") or [],
    }


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


# ── LAN Reconnect API ──────────────────────────────────────


def _get_reconnect_manager():
    """Get or create the ReconnectManager from the LAN plugin."""
    lan_plugin = _lan_plugin_check()
    rm = getattr(lan_plugin, "_reconnect_manager", None)
    if rm is None:
        from plugins.lan_monitor.reconnect import ReconnectManager
        import database as db_mod
        rm = ReconnectManager(db_mod)
        rm.set_ws_clients(connected_clients)
        # Wire up default callback: push notification when a trusted device is discovered
        async def _on_trusted_device_found(device_info: dict):
            msg = json.dumps({
                "type": "reconnect_device_found",
                "device": device_info,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }, default=str)
            await broadcast(msg)
        rm.set_on_device_online(_on_trusted_device_found)
        lan_plugin._reconnect_manager = rm
    return rm


@app.post("/api/lan/reconnect/start")
async def api_lan_reconnect_start(body: dict):
    """Start the auto-reconnect loop."""
    interval = body.get("interval", 30)
    rm = _get_reconnect_manager()
    await rm.start_reconnect_loop(interval=interval)
    return {"status": "ok", "interval": interval}


@app.post("/api/lan/reconnect/stop")
async def api_lan_reconnect_stop():
    """Stop the auto-reconnect loop."""
    try:
        rm = _get_reconnect_manager()
        await rm.stop()
    except HTTPException:
        pass  # Plugin not enabled — nothing to stop
    return {"status": "ok"}


@app.post("/api/lan/reconnect/interval")
async def api_lan_reconnect_interval(body: dict):
    """Update the reconnect check interval."""
    interval = body.get("interval", 30)
    rm = _get_reconnect_manager()
    rm.set_interval(interval)
    return {"status": "ok", "interval": interval}


@app.get("/api/lan/reconnect/status")
async def api_lan_reconnect_status():
    """Get the reconnect loop status."""
    try:
        rm = _get_reconnect_manager()
    except HTTPException:
        return {"running": False, "interval": 30}
    return {
        "running": rm.is_running(),
        "interval": rm.get_interval(),
    }


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
frontend_dir = get_frontend_dir()
frontend_root = frontend_dir.resolve()

@app.get("/{path:path}", include_in_schema=False)
async def serve_frontend(path: str, request: Request):
    raw_path = request.scope.get("raw_path", b"").decode("ascii", "ignore")
    decoded_raw_path = unquote(raw_path)
    if any(part == ".." for part in Path(decoded_raw_path.lstrip("/")).parts):
        raise HTTPException(404, "Not found")

    file_path = (frontend_root / path).resolve()
    try:
        file_path.relative_to(frontend_root)
    except ValueError:
        raise HTTPException(404, "Not found")
    if file_path.exists() and file_path.is_file():
        return FileResponse(file_path)
    if Path(path).suffix:
        raise HTTPException(404, "Not found")
    index_path = frontend_root / "index.html"
    if not index_path.exists():
        return JSONResponse(
            {"error": "frontend_not_found", "path": str(index_path)},
            status_code=503,
        )
    return FileResponse(index_path)


# ── Entry ──────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    cfg = load_config()
    host = cfg.get("http_host", "127.0.0.1")
    port = cfg.get("http_port", 8080)
    print(f"[Pulse] Starting on http://{host}:{port}")
    uvicorn.run(app, host=host, port=port)
