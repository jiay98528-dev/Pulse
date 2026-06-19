"""System data collector using psutil and WMI."""
import psutil
import platform
import json
from datetime import datetime
from typing import Optional


def get_cpu_info() -> dict:
    """Get CPU usage and related info."""
    return {
        "percent": psutil.cpu_percent(interval=0),
        "per_cpu": psutil.cpu_percent(interval=0, percpu=True),
        "count": psutil.cpu_count(),
        "freq": psutil.cpu_freq()._asdict() if psutil.cpu_freq() else {},
        "load_avg": psutil.getloadavg() if hasattr(psutil, "getloadavg") else []
    }


def get_memory_info() -> dict:
    """Get memory usage info."""
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    return {
        "total": mem.total,
        "available": mem.available,
        "used": mem.used,
        "percent": mem.percent,
        "swap_total": swap.total,
        "swap_used": swap.used,
        "swap_percent": swap.percent
    }


def get_disk_info() -> list:
    """Get disk partition info."""
    disks = []
    for part in psutil.disk_partitions():
        try:
            usage = psutil.disk_usage(part.mountpoint)
            disks.append({
                "device": part.device,
                "mountpoint": part.mountpoint,
                "fstype": part.fstype,
                "total": usage.total,
                "used": usage.used,
                "free": usage.free,
                "percent": usage.percent
            })
        except (PermissionError, OSError):
            continue
    return disks


def get_network_info() -> dict:
    """Get network I/O stats."""
    net = psutil.net_io_counters()
    return {
        "bytes_sent": net.bytes_sent,
        "bytes_recv": net.bytes_recv,
        "packets_sent": net.packets_sent,
        "packets_recv": net.packets_recv,
        "errin": net.errin,
        "errout": net.errout,
        "dropin": net.dropin,
        "dropout": net.dropout
    }


def get_gpu_info() -> Optional[dict]:
    """Get GPU info via WMI (Windows)."""
    try:
        import wmi
        c = wmi.WMI()
        gpu_info = []
        for gpu in c.Win32_VideoController():
            gpu_info.append({
                "name": gpu.Name.strip() if gpu.Name else "Unknown",
                "adapter_ram": gpu.AdapterRAM or 0,
                "driver_version": gpu.DriverVersion or "",
                "current_refresh_rate": gpu.CurrentRefreshRate or 0,
            })
        return gpu_info if gpu_info else None
    except ImportError:
        return None
    except Exception:
        return None


def get_temperature_info() -> Optional[dict]:
    """Get temperature info (platform-dependent)."""
    temps = {}
    try:
        if hasattr(psutil, "sensors_temperatures"):
            raw = psutil.sensors_temperatures()
            if raw:
                for name, entries in raw.items():
                    temps[name] = [e._asdict() for e in entries]
                return temps
    except Exception:
        pass
    return None


def get_battery_info() -> Optional[dict]:
    """Get battery status."""
    try:
        battery = psutil.sensors_battery()
        if battery:
            return {
                "percent": battery.percent,
                "power_plugged": battery.power_plugged,
                "secsleft": battery.secsleft
            }
    except Exception:
        pass
    return None


def get_uptime() -> float:
    """Get system uptime in seconds."""
    try:
        import time
        return time.time() - psutil.boot_time()
    except Exception:
        return 0.0


def get_host_info() -> dict:
    """Get basic host system info."""
    return {
        "hostname": platform.node(),
        "system": platform.system(),
        "release": platform.release(),
        "version": platform.version(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "boot_time": psutil.boot_time()
    }


def collect_all() -> dict:
    """Collect all system data at once."""
    return {
        "timestamp": datetime.now().isoformat(),
        "cpu": get_cpu_info(),
        "memory": get_memory_info(),
        "disk": get_disk_info(),
        "network": get_network_info(),
        "gpu": get_gpu_info(),
        "temperature": get_temperature_info(),
        "battery": get_battery_info(),
        "uptime": get_uptime(),
        "host": get_host_info()
    }
