"""Deepseek API data collector — v2.0 balance-only (usage via CSV import)."""
import aiohttp
from datetime import datetime, timezone
from typing import Optional


class DeepseekCollector:
    """Collects balance data from Deepseek API.
    Token usage tracking moved to manual CSV import (M3).
    The /dashboard/usage endpoint (previously at lines 51-96) was confirmed 404 and removed.
    """

    def __init__(self, api_key: str = "", base_url: str = "https://api.deepseek.com"):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.last_balance = 0.0
        self.last_currency = "CNY"

    def is_ready(self) -> bool:
        return bool(self.api_key)

    async def fetch_balance(self) -> Optional[dict]:
        """Fetch current account balance."""
        if not self.is_ready():
            return None
        try:
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Accept": "application/json"
            }
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(f"{self.base_url}/user/balance", timeout=10) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        # Deepseek API returns balance_infos array with full breakdown
                        # e.g. {"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"}]}
                        balance = 0.0
                        granted_balance = 0.0
                        topped_up_balance = 0.0
                        currency = "CNY"
                        if "balance_infos" in data and data["balance_infos"]:
                            info = data["balance_infos"][0]
                            balance = float(info.get("total_balance", info.get("balance", 0)))
                            granted_balance = float(info.get("granted_balance", 0))
                            topped_up_balance = float(info.get("topped_up_balance", 0))
                            currency = info.get("currency", "CNY")
                        elif "available_balance" in data:
                            balance = float(data["available_balance"])
                        elif "balance" in data:
                            balance = float(data["balance"])
                        self.last_balance = balance
                        self.last_currency = currency
                        return {
                            "balance": balance,
                            "granted_balance": granted_balance,
                            "topped_up_balance": topped_up_balance,
                            "currency": currency
                        }
                    return None
        except Exception:
            return None

    async def fetch_all(self) -> dict:
        """Fetch Deepseek balance only. Usage tracking via CSV import (M3)."""
        balance = await self.fetch_balance()
        return {
            "balance": balance,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
