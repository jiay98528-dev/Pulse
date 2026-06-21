"""Pulse configuration loader."""
import copy
import json
import os
from pathlib import Path

CONFIG_PATH = Path(__file__).parent / "config.json"
DEFAULT_CONFIG = {
    "ai_provider": "deepseek",
    "deepseek_api_key": "",
    "deepseek_base_url": "https://api.deepseek.com",
    "openai_api_key": "",
    "openai_base_url": "https://api.openai.com",
    "anthropic_api_key": "",
    "anthropic_base_url": "https://api.anthropic.com",
    "daily_spending_limit": 5.0,
    "monthly_spending_limit": 100.0,
    "wmi_remote": {
        "enabled": False,
        "host": "",
        "username": "",
        "password": ""
    },
    "websocket_port": 8765,
    "http_host": "127.0.0.1",
    "http_port": 8080
}


def load_config() -> dict:
    """Load config from JSON file, creating default if missing."""
    if not CONFIG_PATH.exists():
        save_config(DEFAULT_CONFIG)
        return copy.deepcopy(DEFAULT_CONFIG)

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
            # Merge with defaults to fill missing keys
            merged = copy.deepcopy(DEFAULT_CONFIG)
            merged.update(cfg)
            return merged
    except (json.JSONDecodeError, IOError):
        return copy.deepcopy(DEFAULT_CONFIG)


def save_config(cfg: dict) -> bool:
    """Save config to JSON file."""
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        return True
    except IOError:
        return False


def is_configured() -> bool:
    """Check if the selected AI provider has an API key configured."""
    cfg = load_config()
    provider = cfg.get("ai_provider", "deepseek")
    key = cfg.get(f"{provider}_api_key", "")
    return bool(key and key.strip())
