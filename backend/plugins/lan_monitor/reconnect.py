"""重连管理器 — 持久信任设备的自动发现与 WebSocket 重连。

负责定期扫描局域网内已持久信任的设备，检测其在线状态，
并在设备上线时自动建立 WebSocket 连接。

依赖:
- discovery.py: UDP 广播发现
- pairing.py: 持久信任设备查询

注意：此功能需要真实局域网环境验证。
在 localhost 单一设备环境下无法测试实际重连流程。
"""

import asyncio
import json
import time
from typing import Optional

from plugins.lan_monitor.discovery import send_discovery_broadcast


# 默认重连间隔（秒）
DEFAULT_RECONNECT_INTERVAL = 30

# 默认 UDP ping 超时
DEFAULT_PING_TIMEOUT = 5.0


class ReconnectManager:
    """持久信任设备重连管理器。

    每 interval 秒检查一次已持久信任的设备列表，
    对不在线的设备发送 UDP ping，
    设备响应后尝试建立 WebSocket 连接。

    Args:
        db: 数据库模块引用（用于 CRUD 操作）。
    """

    def __init__(self, db):
        self._db = db
        self._running = False
        self._loop_task: Optional[asyncio.Task] = None
        self._interval = DEFAULT_RECONNECT_INTERVAL
        self._ping_timeout = DEFAULT_PING_TIMEOUT
        self._on_device_online_cb = None  # callback: async def cb(device_info) -> None
        self._connected_ws_clients: set = set()

    # ── 生命周期 ──────────────────────────────────────

    async def start_reconnect_loop(self, interval: int = 30):
        """启动重连循环。

        每 interval 秒执行一次：
        1. 从数据库加载所有持久信任设备
        2. 检查持久信任设备列表是否为空 → 跳过
        3. 发送 UDP 广播扫描
        4. 对发现的设备检查是否为已持久信任设备
        5. 对匹配的信任设备调用 on_device_online 回调

        Args:
            interval: 扫描间隔（秒），默认 30。
        """
        if self._running:
            print("[Reconnect] 重连循环已在运行")
            return

        self._running = True
        self._interval = interval
        print(f"[Reconnect] 重连循环启动，间隔 {interval} 秒")

        self._loop_task = asyncio.create_task(self._reconnect_loop())
        return self._loop_task

    async def stop(self):
        """停止重连循环并清理资源。"""
        self._running = False

        if self._loop_task is not None:
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
            self._loop_task = None

        print("[Reconnect] 重连循环已停止")

    # ── 配置 ──────────────────────────────────────────

    def set_interval(self, seconds: int):
        """设置重连检查间隔。"""
        if seconds < 10:
            seconds = 10  # 最小间隔 10 秒
        self._interval = seconds

    def set_ping_timeout(self, seconds: float):
        """设置 UDP ping 超时时间。"""
        self._ping_timeout = max(1.0, seconds)

    def set_on_device_online(self, callback):
        """设置设备上线回调。

        callback 签名: async def cb(device_info: dict) -> None
        device_info 包含: {device_id, name, ip, shared_metrics, ...}
        """
        self._on_device_online_cb = callback

    def set_ws_clients(self, clients_set: set):
        """设置 WebSocket 客户端集合引用，用于推送重连状态。"""
        self._connected_ws_clients = clients_set

    # ── 核心循环 ──────────────────────────────────────

    async def _reconnect_loop(self):
        """重连主循环 — 内部实现。"""
        while self._running:
            try:
                await self._check_and_reconnect()
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[Reconnect] 检查异常: {e}")

            # 等待下一个周期
            for _ in range(self._interval):
                if not self._running:
                    break
                await asyncio.sleep(1)

    async def _check_and_reconnect(self):
        """执行一次重连检查。"""
        try:
            trusted_devices = await self._db.get_lan_trusted_devices()
        except AttributeError:
            # 数据库可能还未实现 get_lan_trusted_devices 方法
            print("[Reconnect] 注意: 数据库未实现 get_lan_trusted_devices，跳过检查")
            return

        if not trusted_devices:
            # 没有持久信任设备，无需重连
            return

        # 发送 UDP 广播，发现局域网设备
        discovered = await send_discovery_broadcast(timeout=self._ping_timeout)

        if not discovered:
            # 未发现任何设备，跳过
            return

        # 建立信任设备 IP -> 设备信息的映射
        trusted_by_ip = {}
        for dev in trusted_devices:
            ip = dev.get("ip", "")
            if ip:
                trusted_by_ip[ip] = dev

        # 检查发现的设备是否在信任列表中
        for remote in discovered:
            remote_ip = remote.get("ip", "")
            if remote_ip in trusted_by_ip:
                trusted = trusted_by_ip[remote_ip]
                device_id = trusted.get("device_id") or trusted.get("id")

                # 检查是否已在线（可以通过已配对设备列表判断）
                try:
                    paired_devices = await self._db.get_lan_paired_devices()
                except AttributeError:
                    paired_devices = []

                already_paired = any(
                    p.get("ip") == remote_ip or p.get("device_id") == device_id
                    for p in paired_devices
                )

                if already_paired:
                    # 已配对且在线，跳过
                    continue

                print(f"[Reconnect] 发现持久信任设备上线: {trusted.get('name', remote_ip)} ({remote_ip})")

                # 调用上线回调，尝试建立 WebSocket 连接
                if self._on_device_online_cb:
                    try:
                        await self._on_device_online_cb({
                            "device_id": device_id,
                            "name": trusted.get("name", remote_ip),
                            "ip": remote_ip,
                            "shared_metrics": trusted.get("shared_metrics", "cpu,memory,disk,network"),
                            "source": "reconnect",
                        })
                    except Exception as e:
                        print(f"[Reconnect] 设备上线回调失败: {e}")

                # 推送通知到前端
                self._broadcast_reconnect_event({
                    "type": "reconnect_success",
                    "device": {
                        "id": device_id,
                        "name": trusted.get("name", remote_ip),
                        "ip": remote_ip,
                    },
                })

    # ── 内部辅助 ──────────────────────────────────────

    def _broadcast_reconnect_event(self, msg: dict):
        """向前端所有 WebSocket 客户端广播重连事件。"""
        payload = json.dumps(msg)
        dead = set()
        for ws in self._connected_ws_clients:
            try:
                # 使用 asyncio.create_task 避免阻塞
                asyncio.create_task(self._safe_send(ws, payload))
            except Exception:
                dead.add(ws)
        self._connected_ws_clients.difference_update(dead)

    async def _safe_send(self, ws, payload: str):
        """安全地向单个 WebSocket 发送消息。"""
        try:
            await ws.send_text(payload)
        except Exception:
            pass

    # ── 状态查询 ──────────────────────────────────────

    def is_running(self) -> bool:
        """返回重连循环是否正在运行。"""
        return self._running

    def get_interval(self) -> int:
        """返回当前重连检查间隔（秒）。"""
        return self._interval


# ── 独立使用示例（需真实局域网环境验证）──────────────────
#
# async def example_usage():
#     from database import Database  # 假设的数据库模块
#     db = Database()
#     manager = ReconnectManager(db)
#
#     async def on_device_online(info):
#         print(f"设备上线: {info}")
#         # 在此处建立 WebSocket 连接 ...
#
#     manager.set_on_device_online(on_device_online)
#     await manager.start_reconnect_loop(interval=30)
#
#     # ... 保持运行 ...
#
#     await manager.stop()
