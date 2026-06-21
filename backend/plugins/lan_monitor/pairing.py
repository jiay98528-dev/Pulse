"""配对管理 — LAN 设备 WebSocket 配对 + 弹窗授权 + 持久信任。

配对流程:
1. 主控端发现设备 → POST /api/lan/pair-request {ip, name}
2. 被控端收到配对请求 → 前端弹窗授权（通过 WebSocket 推送）
3. 用户点允许 → POST /api/lan/pair-approve {token}
4. 配对成功 → WebSocket 开始推送数据

持久信任:
- 配对时可选择"持久信任"，需要输入 PIN 验证
- 持久信任的设备下次配对无需再次授权
"""

import json
import random
import secrets
import time
from datetime import datetime, timezone
from typing import Optional

from config import load_config, save_config

# 配对请求过期时间（秒）
PENDING_REQUEST_TTL = 120

# 存储待处理的配对请求（内存中）
# { token: { ip, name, device_id, timestamp } }
_pending_requests: dict[str, dict] = {}

# PairingManager 引用（用于访问数据库）
_manager_instance = None


class PairingManager:
    """LAN 设备配对管理器。

    管理配对请求的创建、审批、拒绝和已配对设备的持久化。
    """

    def __init__(self, db):
        """初始化配对管理器。

        Args:
            db: 数据库模块引用（用于 CRUD 操作）。
        """
        self._db = db
        self._pending_requests: dict[str, dict] = {}
        # 持久信任 PIN（从配置文件读取，不存在则随机生成并持久化）
        cfg = load_config()
        self._trust_pin = cfg.get("lan_trust_pin", "") or str(random.randint(100000, 999999))
        if not cfg.get("lan_trust_pin"):
            cfg["lan_trust_pin"] = self._trust_pin
            save_config(cfg)
        global _manager_instance
        _manager_instance = self
        self._connected_ws_clients: set = set()

    def set_ws_clients(self, clients_set: set):
        """设置 WebSocket 客户端集合引用，用于推送配对请求到前端。"""
        self._connected_ws_clients = clients_set

    # ── 配对请求 ──────────────────────────────────────

    async def request_pair(self, device_ip: str, device_name: str = "") -> dict:
        """发起配对请求。

        生成一个唯一的 token，存储待处理请求，
        并尝试通过 WebSocket 通知目标设备。

        Args:
            device_ip: 目标设备 IP。
            device_name: 目标设备名称（可选）。

        Returns:
            dict: { token, status: "pending" }
        """
        # 检查是否已经配对
        existing = await self._db.find_paired_device_by_ip(device_ip)
        if existing:
            return {"status": "already_paired", "device": existing}

        # 检查持久信任设备
        trusted = await self._db.find_trusted_device_by_ip(device_ip)
        if trusted:
            # 持久信任设备自动配对
            device_id = await self._db.add_lan_paired_device(
                device_id=trusted.get("device_id", device_ip),
                name=trusted.get("name", device_name or device_ip),
                ip=device_ip,
                shared_metrics=trusted.get("shared_metrics", "cpu,memory,disk,network"),
                persistent_trust=1,
                token="trusted",
            )
            return {"status": "approved", "device_id": device_id}

        # 生成新配对请求
        token = secrets.token_hex(16)
        self._pending_requests[token] = {
            "ip": device_ip,
            "name": device_name or device_ip,
            "timestamp": time.time(),
            "device_id": None,
        }

        # 尝试通过 WebSocket 推送配对请求到前端
        ws_msg = json.dumps({
            "type": "pair_request",
            "token": token,
            "from": {
                "ip": device_ip,
                "name": device_name or device_ip,
            }
        })
        dead = set()
        for ws in self._connected_ws_clients:
            try:
                await ws.send_text(ws_msg)
            except Exception:
                dead.add(ws)
        self._connected_ws_clients.difference_update(dead)

        return {"status": "pending", "token": token}

    async def approve_pair(self, token: str, persistent: bool = False, pin: str = "") -> dict:
        """批准配对请求。

        Args:
            token: 配对请求 token。
            persistent: 是否持久信任。
            pin: 持久信任 PIN（如果 persistent=True）。

        Returns:
            dict: { status, device_id? }
        """
        request = self._pending_requests.get(token)
        if not request:
            # 检查是否是自配对 token
            return {"status": "error", "message": "配对请求已过期或无效"}

        # 验证 TTL
        if time.time() - request["timestamp"] > PENDING_REQUEST_TTL:
            del self._pending_requests[token]
            return {"status": "error", "message": "配对请求已过期"}

        # 验证持久信任 PIN
        if persistent:
            if len(pin) < 4 or pin != self._trust_pin:
                return {"status": "error", "message": "PIN 错误（至少4位数字）"}
            trust_flag = 1
        else:
            trust_flag = 0

        # 保存配对设备
        device_id = await self._db.add_lan_paired_device(
            device_id=token[:8],  # 用 token 前缀作为设备 ID
            name=request["name"],
            ip=request["ip"],
            shared_metrics="cpu,memory,disk,network",
            persistent_trust=trust_flag,
            token=token,
        )

        # 清理待处理请求
        del self._pending_requests[token]

        # 广播配对成功消息
        success_msg = json.dumps({
            "type": "pair_success",
            "device": {
                "id": device_id,
                "name": request["name"],
                "ip": request["ip"],
            }
        })
        dead = set()
        for ws in self._connected_ws_clients:
            try:
                await ws.send_text(success_msg)
            except Exception:
                dead.add(ws)
        self._connected_ws_clients.difference_update(dead)

        return {"status": "approved", "device_id": device_id}

    async def reject_pair(self, token: str) -> dict:
        """拒绝配对请求。

        Args:
            token: 配对请求 token。

        Returns:
            dict: { status }
        """
        request = self._pending_requests.pop(token, None)
        if not request:
            return {"status": "error", "message": "配对请求已过期或无效"}

        # 广播拒绝消息
        reject_msg = json.dumps({
            "type": "pair_rejected",
            "ip": request["ip"],
        })
        dead = set()
        for ws in self._connected_ws_clients:
            try:
                await ws.send_text(reject_msg)
            except Exception:
                dead.add(ws)
        self._connected_ws_clients.difference_update(dead)

        return {"status": "rejected"}

    # ── 已配对设备管理 ─────────────────────────────────

    async def get_paired_devices(self) -> list[dict]:
        """获取所有已配对设备列表。"""
        return await self._db.get_lan_paired_devices()

    async def unpair(self, device_id: int) -> bool:
        """解除设备配对。"""
        return await self._db.delete_lan_paired_device(device_id)

    async def update_metrics(self, device_id: int, metrics: str) -> bool:
        """更新设备的共享指标配置。"""
        return await self._db.update_lan_paired_device_metrics(device_id, metrics)

    # ── 待处理请求查询 ─────────────────────────────────

    def get_pending_requests(self) -> list[dict]:
        """获取所有待处理的配对请求列表。"""
        now = time.time()
        # 清理过期请求
        expired = [t for t, r in self._pending_requests.items()
                   if now - r["timestamp"] > PENDING_REQUEST_TTL]
        for t in expired:
            del self._pending_requests[t]

        return [
            {
                "token": t,
                "ip": r["ip"],
                "name": r["name"],
                "remaining_sec": max(0, int(PENDING_REQUEST_TTL - (now - r["timestamp"]))),
            }
            for t, r in self._pending_requests.items()
        ]

    # ── Self-pairing（本地测试） ────────────────────────

    async def self_pair(self) -> dict:
        """Self-pair 模式 — 用于 localhost 测试。

        允许同一台设备与自身配对，用于开发和测试。
        不需要 UDP 发现或 WebSocket 弹窗。
        """
        import socket
        try:
            ip = socket.gethostbyname(socket.gethostname())
        except Exception:
            ip = "127.0.0.1"

        existing = await self._db.find_paired_device_by_ip(ip)
        if existing:
            return {"status": "already_paired", "device": existing}

        device_id = await self._db.add_lan_paired_device(
            device_id="self",
            name=f"Localhost ({ip})",
            ip=ip,
            shared_metrics="cpu,memory,disk,network",
            persistent_trust=1,
            token="self-pair",
        )

        return {"status": "approved", "device_id": device_id, "ip": ip}
