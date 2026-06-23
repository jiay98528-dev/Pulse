"""Runtime path helpers for development and packaged Pulse builds."""

import os
import sys
from pathlib import Path


def is_frozen() -> bool:
    """Return True when running from a PyInstaller executable."""
    return bool(getattr(sys, "frozen", False))


def get_project_root() -> Path:
    """Return the repository root in development mode."""
    return Path(__file__).resolve().parent.parent


def get_bundle_root() -> Path:
    """Return the root containing bundled read-only assets."""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS")).resolve()
    return get_project_root()


def _env_path(name: str) -> Path | None:
    value = os.environ.get(name)
    if not value:
        return None
    return Path(value).expanduser().resolve()


def get_data_dir() -> Path:
    """Return the writable directory for runtime data."""
    return _env_path("PULSE_DATA_DIR") or (get_project_root() / "data")


def get_config_path() -> Path:
    """Return the JSON config path, preserving the development location."""
    data_dir = _env_path("PULSE_DATA_DIR")
    if data_dir:
        return data_dir / "config.json"
    return Path(__file__).resolve().parent / "config.json"


def get_db_path() -> Path:
    """Return the SQLite database path."""
    return get_data_dir() / "pulse.db"


def get_frontend_dir() -> Path:
    """Return the frontend static asset directory."""
    return _env_path("PULSE_FRONTEND_DIR") or (get_bundle_root() / "frontend")


def get_plugins_dir() -> Path:
    """Return the plugin discovery directory."""
    env_path = _env_path("PULSE_PLUGINS_DIR")
    if env_path:
        return env_path
    if is_frozen():
        return get_bundle_root() / "plugins"
    return Path(__file__).resolve().parent / "plugins"
