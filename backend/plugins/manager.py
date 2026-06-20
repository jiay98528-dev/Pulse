"""PluginManager — discover, load, and manage Pulse plugins."""

import importlib
import inspect
import sys
from pathlib import Path
from typing import Optional

from plugins.base import PluginBase

PLUGINS_DIR = Path(__file__).parent


class PluginManager:
    """Scans backend/plugins/ for subdirectories containing plugin.py,
    dynamically imports each PluginBase subclass, and manages their lifecycle."""

    def __init__(self):
        self.plugins: dict[str, PluginBase] = {}

    def discover(self) -> list[dict]:
        """Scan backend/plugins/ for plugin packages and register them.

        Each subdirectory is expected to contain a plugin.py module that
        defines exactly one subclass of PluginBase.

        Returns a list of status dicts for all found (but not yet initialised) plugins.
        """
        found = []
        for entry in sorted(PLUGINS_DIR.iterdir()):
            if not entry.is_dir():
                continue
            if entry.name.startswith("_") or entry.name.startswith("."):
                continue
            if entry.name == "__pycache__":
                continue

            plugin_path = entry / "plugin.py"
            if not plugin_path.exists():
                continue

            plugin_instance = self._load_plugin(entry.name, plugin_path)
            if plugin_instance is not None:
                self.plugins[plugin_instance.name] = plugin_instance
                found.append({
                    "name": plugin_instance.name,
                    "module": entry.name,
                    "version": plugin_instance.version,
                    "description": plugin_instance.description,
                    "enabled": plugin_instance.enabled,
                })

        return found

    def _load_plugin(self, module_name: str, plugin_path: Path) -> Optional[PluginBase]:
        """Dynamically import a plugin module and return its PluginBase instance."""
        try:
            import_name = f"plugins.{module_name}.plugin"
            if import_name in sys.modules:
                mod = sys.modules[import_name]
            else:
                mod = importlib.import_module(import_name)

            for _, obj in inspect.getmembers(mod, inspect.isclass):
                if (
                    issubclass(obj, PluginBase)
                    and obj is not PluginBase
                ):
                    instance = obj()
                    return instance

            print(f"[Plugin] {module_name}/plugin.py has no PluginBase subclass — skipped")
        except Exception as e:
            print(f"[Plugin] Failed to load {module_name}: {e}")

        return None

    async def init_all(self) -> list[dict]:
        """Call init() on all discovered plugins and return their status."""
        results = []
        for name, plugin in self.plugins.items():
            try:
                await plugin.init()
                results.append({
                    "name": name,
                    "init": True,
                    "enabled": plugin.enabled,
                })
            except Exception as e:
                print(f"[Plugin] init() failed for {name}: {e}")
                results.append({
                    "name": name,
                    "init": False,
                    "error": str(e),
                })

        for plugin in self.plugins.values():
            if plugin.enabled:
                try:
                    await plugin.start()
                except Exception as e:
                    print(f"[Plugin] start() failed for {plugin.name}: {e}")

        return results

    def get_plugin(self, name: str) -> Optional[PluginBase]:
        """Get a plugin instance by its human-readable name, or None."""
        return self.plugins.get(name)

    def get_all_status(self) -> list[dict]:
        """Return a list of status dicts for every discovered plugin."""
        return [
            {
                "name": p.name,
                "version": p.version,
                "description": p.description,
                "enabled": p.enabled,
            }
            for p in self.plugins.values()
        ]

    async def enable(self, name: str) -> bool:
        """Enable a plugin by name. Calls start(). Returns True on success."""
        plugin = self.plugins.get(name)
        if plugin is None or plugin.enabled:
            return False

        plugin.enabled = True
        try:
            await plugin.start()
            return True
        except Exception as e:
            plugin.enabled = False
            print(f"[Plugin] start() failed on enable {name}: {e}")
            return False

    async def disable(self, name: str) -> bool:
        """Disable a plugin by name. Calls stop(). Returns True on success."""
        plugin = self.plugins.get(name)
        if plugin is None or not plugin.enabled:
            return False

        try:
            await plugin.stop()
        except Exception as e:
            print(f"[Plugin] stop() failed on disable {name}: {e}")
        finally:
            plugin.enabled = False

        return True
