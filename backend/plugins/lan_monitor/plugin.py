"""LAN 设备监控插件 — 局域网跨设备系统状态监控。

集成了 UDP 广播发现、WebSocket 配对、持久信任等功能。
M5 里程碑核心插件。
"""

from plugins.base import PluginBase
from plugins.lan_monitor.discovery import (
    start_discovery_listener,
    stop_discovery_listener,
    send_discovery_broadcast,
)
from plugins.lan_monitor.pairing import PairingManager
from plugins.lan_monitor.reconnect import ReconnectManager


class LANMonitorPlugin(PluginBase):
    name = "LAN 设备监控"
    version = "1.0.0"
    description = "局域网跨设备系统状态监控 — UDP 发现 + WebSocket 配对"
    enabled = False

    async def init(self):
        """One-time setup: prepare internal state."""
        self._running = False
        self._discovery_transport = None
        self._discovery_protocol = None
        self._reconnect_manager = None
        self._reconnect_task = None
        self.device_name = None  # Will be set from config

    async def start(self):
        """Start background monitoring loop and discovery listener."""
        self._running = True

        # Read device_name from config (fallback to hostname if not set)
        try:
            from config import load_config
            cfg = load_config()
            cfg_name = cfg.get("lan_device_name", "")
            if cfg_name:
                self.device_name = cfg_name
        except Exception:
            pass  # best-effort: discovery.py falls back to hostname

        # Start UDP discovery listener (best-effort)
        transport = await start_discovery_listener(self)
        if transport is None:
            print("[Plugin LAN] 注意: UDP 发现监听器未启动（端口可能被占用）")
            print("[Plugin LAN] 配对仍可通过手动添加设备 API 完成")

        # Start reconnect manager if configured
        await self._maybe_start_reconnect()

        print("[Plugin LAN] 设备监控 started")

    async def stop(self):
        """Stop background monitoring loop and discovery listener."""
        self._running = False

        # Stop reconnect manager
        await self._maybe_stop_reconnect()

        await stop_discovery_listener(self)

        print("[Plugin LAN] 设备监控 stopped")

    async def _maybe_start_reconnect(self):
        """Start reconnect manager if DB is available and auto-reconnect is desired."""
        if self._reconnect_manager is not None:
            try:
                await self._reconnect_manager.start_reconnect_loop(interval=30)
            except Exception as e:
                print(f"[Plugin LAN] 重连管理器启动失败: {e}")

    async def _maybe_stop_reconnect(self):
        """Stop reconnect manager if running."""
        if self._reconnect_manager is not None:
            try:
                await self._reconnect_manager.stop()
            except Exception:
                pass

    async def get_status(self):
        return {
            "enabled": self.enabled,
            "running": getattr(self, "_running", False),
            "discovery_active": getattr(self, "_discovery_transport", None) is not None,
        }

    async def get_config_schema(self):
        return {
            "type": "object",
            "properties": {
                "scan_interval_sec": {
                    "type": "integer",
                    "default": 30,
                    "description": "网络扫描间隔（秒）",
                },
                "udp_broadcast_port": {
                    "type": "integer",
                    "default": 42069,
                    "description": "UDP 发现端口",
                },
                "device_name": {
                    "type": "string",
                    "default": "",
                    "description": "此设备在网络中显示的名称（留空使用主机名）",
                },
            },
        }

    # ── Convenience wrappers ──────────────────────────────────

    async def scan_network(self, timeout: float = 5.0) -> list[dict]:
        """Send UDP broadcast and return discovered devices.

        Returns a list of {name, hostname, ip, version, platform} dicts.
        """
        if not self._running:
            return []
        return await send_discovery_broadcast(timeout=timeout)

    async def get_pairing_manager(self, db) -> PairingManager:
        """Get (or create) a PairingManager instance bound to this plugin."""
        if not hasattr(self, "_pairing_manager") or self._pairing_manager is None:
            self._pairing_manager = PairingManager(db)
        return self._pairing_manager

    async def get_reconnect_manager(self, db=None) -> ReconnectManager:
        """Get (or create) a ReconnectManager instance bound to this plugin."""
        if self._reconnect_manager is None:
            from plugins.lan_monitor.reconnect import ReconnectManager
            self._reconnect_manager = ReconnectManager(db)
        return self._reconnect_manager
