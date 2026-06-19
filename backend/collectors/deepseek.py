"""Deepseek API data collector."""
import aiohttp
from datetime import datetime, timezone, timedelta
from typing import Optional


class DeepseekCollector:
    """Collects usage data from Deepseek API."""

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
                        balance = data.get("balance", 0)
                        currency = data.get("currency", "CNY")
                        if "available_balance" in data:
                            balance = data["available_balance"]
                        self.last_balance = float(balance)
                        self.last_currency = currency
                        return {"balance": self.last_balance, "currency": self.last_currency}
                    return None
        except Exception:
            return None

    async def fetch_usage(self, days: int = 7) -> Optional[list]:
        """Fetch token usage for the last N days.
        Returns a list of usage records with model breakdown.
        """
        if not self.is_ready():
            return None
        try:
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Accept": "application/json"
            }
            now = datetime.now(timezone.utc)
            from_ts = int((now - timedelta(days=days)).timestamp())
            to_ts = int(now.timestamp())

            async with aiohttp.ClientSession(headers=headers) as session:
                url = f"{self.base_url}/dashboard/usage?from={from_ts}&to={to_ts}"
                async with session.get(url, timeout=15) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return self._parse_usage_response(data)
                    return None
        except Exception:
            return None

    def _parse_usage_response(self, data: dict) -> list:
        """Parse Deepseek API usage response into normalized records."""
        records = []
        usage_data = data.get("data", data.get("usage_data", []))
        if not usage_data:
            # Try flat format
            if "total_tokens" in data:
                usage_data = [data]

        for item in usage_data:
            model = item.get("model", item.get("model_id", "deepseek-chat"))
            records.append({
                "model": model,
                "input_tokens": item.get("input_tokens", item.get("prompt_tokens", 0)),
                "output_tokens": item.get("output_tokens", item.get("completion_tokens", 0)),
                "cached_tokens": item.get("cached_tokens", item.get("cached_input_tokens", 0)),
                "total_tokens": item.get("total_tokens", 0),
                "cost": item.get("cost", item.get("total_cost", 0.0)),
            })

        return records

    async def fetch_all(self) -> dict:
        """Fetch all Deepseek data (balance + recent usage)."""
        balance = await self.fetch_balance()
        usage = await self.fetch_usage(days=7)
        return {
            "balance": balance,
            "usage": usage or [],
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
