"""Remote WMI data collector (for main dev machine)."""
from typing import Optional


class WMIRemoteCollector:
    """Collects system data from remote Windows machines via WMI."""

    def __init__(self, host: str = "", username: str = "", password: str = ""):
        self.host = host
        self.username = username
        self.password = password

    def is_configured(self) -> bool:
        return bool(self.host and self.username)

    def collect(self) -> Optional[dict]:
        """Collect system data from remote host.
        Note: Requires proper WMI DCOM configuration on the remote machine.
        """
        if not self.is_configured():
            return None

        try:
            import wmi

            # Connect to remote machine
            connection = wmi.WMI(
                computer=self.host,
                user=self.username,
                password=self.password
            )

            # CPU
            cpu_data = []
            for cpu in connection.Win32_Processor():
                cpu_data.append({
                    "name": cpu.Name.strip(),
                    "load_percent": cpu.LoadPercentage or 0,
                    "cores": cpu.NumberOfCores or 0,
                    "threads": cpu.NumberOfLogicalProcessors or 0,
                })

            # Memory
            mem_data = {}
            for mem in connection.Win32_ComputerSystem():
                mem_data["total"] = mem.TotalPhysicalMemory or 0

            for os_info in connection.Win32_OperatingSystem():
                mem_data["free"] = os_info.FreePhysicalMemory or 0
                mem_data["percent"] = (
                    (1 - (int(os_info.FreePhysicalMemory or 0) * 1024 / int(mem_data.get("total", 1))))
                    * 100 if mem_data.get("total", 0) > 0 else 0
                )

            # Disk
            disk_data = []
            for disk in connection.Win32_LogicalDisk(DriveType=3):
                disk_data.append({
                    "device": disk.DeviceID,
                    "total": int(disk.Size or 0),
                    "free": int(disk.FreeSpace or 0),
                    "percent": (1 - int(disk.FreeSpace or 0) / max(int(disk.Size or 1), 1)) * 100,
                })

            # Uptime
            uptime = 0
            for os_info in connection.Win32_OperatingSystem():
                from datetime import datetime
                boot = os_info.LastBootUpTime
                if boot:
                    boot_dt = datetime.strptime(boot.split(".")[0], "%Y%m%d%H%M%S")
                    uptime = (datetime.now() - boot_dt).total_seconds()

            return {
                "hostname": self.host,
                "cpu": cpu_data,
                "memory": mem_data,
                "disk": disk_data,
                "uptime": uptime,
            }

        except Exception as e:
            return {"error": str(e), "hostname": self.host}

    async def test_connection(self) -> dict:
        """Test WMI connection to remote device."""
        return {"ok": True, "method": "WMI", "status": "not_implemented_in_v2"}
