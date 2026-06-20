"""UDP 广播发现 — LAN 设备自动发现协议。

Pulse 使用自定义 UDP 协议进行局域网设备发现：
- 端口: 42069
- 请求报文: b"PULSE_DISCOVER"
- 响应报文: JSON { name, hostname, ip, version, platform }

注意：此功能需要真实局域网环境验证。
在 localhost 单一设备环境下，发现结果为空（除非 self-pair 模式）。
"""

import asyncio
import json
import socket
from datetime import datetime
from typing import Optional

PULSE_LAN_PORT = 42069
PULSE_DISCOVERY_MSG = b"PULSE_DISCOVER"
PULSE_RESPONSE_PREFIX = b"PULSE_RESP:"
BROADCAST_ADDR = "255.255.255.255"


def _get_local_ip() -> str:
    """Get the local IP address of this machine."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _get_hostname() -> str:
    """Get the local hostname."""
    try:
        return socket.gethostname()
    except Exception:
        return "unknown"


def _build_response_payload(plugin) -> bytes:
    """Build the UDP response payload for a discovery request."""
    info = {
        "name": getattr(plugin, "device_name", _get_hostname()),
        "hostname": _get_hostname(),
        "ip": _get_local_ip(),
        "version": getattr(plugin, "version", "1.0.0"),
        "platform": "windows",
    }
    return PULSE_RESPONSE_PREFIX + json.dumps(info).encode("utf-8")


def _parse_response(data: bytes) -> Optional[dict]:
    """Parse a UDP discovery response. Returns None if invalid."""
    if not data.startswith(PULSE_RESPONSE_PREFIX):
        return None
    try:
        payload = data[len(PULSE_RESPONSE_PREFIX):].decode("utf-8")
        return json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


async def start_discovery_listener(plugin):
    """Listen for UDP discovery broadcasts and respond with device info.

    Binds to PULSE_LAN_PORT and waits for PULSE_DISCOVERY_MSG.
    Responds with JSON-encoded device information.

    Args:
        plugin: The LANMonitorPlugin instance (used for device name/version).
    """
    loop = asyncio.get_event_loop()

    class DiscoveryProtocol(asyncio.DatagramProtocol):
        def connection_made(self, transport):
            self.transport = transport
            sock = transport.get_extra_info("socket")
            if sock is not None:
                try:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    # Enable broadcast reception
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                except Exception:
                    pass
            print(f"[LAN Discovery] Listening on UDP port {PULSE_LAN_PORT}")

        def datagram_received(self, data, addr):
            if data.strip() == PULSE_DISCOVERY_MSG:
                # Respond with device info
                response = _build_response_payload(plugin)
                try:
                    self.transport.sendto(response, addr)
                    print(f"[LAN Discovery] Responded to {addr}")
                except Exception as e:
                    print(f"[LAN Discovery] Failed to respond to {addr}: {e}")

        def error_received(self, exc):
            print(f"[LAN Discovery] Socket error: {exc}")

    try:
        transport, protocol = await loop.create_datagram_endpoint(
            DiscoveryProtocol,
            local_addr=("0.0.0.0", PULSE_LAN_PORT),
            allow_broadcast=True,
        )
        plugin._discovery_transport = transport
        plugin._discovery_protocol = protocol
        return transport
    except OSError as e:
        print(f"[LAN Discovery] Failed to bind UDP port {PULSE_LAN_PORT}: {e}")
        print("[LAN Discovery] Discovery listener not started — port may be in use.")
        return None


async def stop_discovery_listener(plugin):
    """Stop the UDP discovery listener."""
    transport = getattr(plugin, "_discovery_transport", None)
    if transport:
        try:
            transport.close()
        except Exception:
            pass
        plugin._discovery_transport = None
        plugin._discovery_protocol = None
        print("[LAN Discovery] Listener stopped")


async def send_discovery_broadcast(timeout: float = 5.0) -> list[dict]:
    """Send UDP broadcast discovery request and collect responses.

    Sends PULSE_DISCOVERY_MSG to 255.255.255.255:PULSE_LAN_PORT,
    then waits `timeout` seconds for responses.

    Args:
        timeout: Seconds to wait for responses after broadcast.

    Returns:
        List of discovered device info dicts.
    """
    loop = asyncio.get_event_loop()
    discovered = []

    class BroadcastProtocol(asyncio.DatagramProtocol):
        def connection_made(self, transport):
            self.transport = transport
            sock = transport.get_extra_info("socket")
            if sock is not None:
                try:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                except Exception:
                    pass
            # Send broadcast
            try:
                transport.sendto(PULSE_DISCOVERY_MSG, (BROADCAST_ADDR, PULSE_LAN_PORT))
                print(f"[LAN Discovery] Broadcast sent to {BROADCAST_ADDR}:{PULSE_LAN_PORT}")
            except Exception as e:
                print(f"[LAN Discovery] Broadcast send failed: {e}")

        def datagram_received(self, data, addr):
            info = _parse_response(data)
            if info:
                info["addr"] = addr[0]
                # Deduplicate by IP
                for existing in discovered:
                    if existing.get("ip") == info.get("ip"):
                        return
                discovered.append(info)
                print(f"[LAN Discovery] Received response from {addr[0]}: {info.get('name', '?')}")

        def error_received(self, exc):
            print(f"[LAN Discovery] Broadcast recv error: {exc}")

    try:
        transport, protocol = await loop.create_datagram_endpoint(
            BroadcastProtocol,
            local_addr=("0.0.0.0", 0),  # ephemeral port
            allow_broadcast=True,
        )

        await asyncio.sleep(timeout)

        transport.close()
        return discovered

    except OSError as e:
        print(f"[LAN Discovery] Broadcast error: {e}")
        return discovered
