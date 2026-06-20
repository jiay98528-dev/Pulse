"""PluginBase — abstract base class for all Pulse plugins."""


class PluginBase:
    """All plugins must subclass this and override the async lifecycle hooks.

    Attributes:
        name: Human-readable plugin name.
        version: Semver string, e.g. "1.0.0".
        description: One-line summary of what the plugin does.
        enabled: Whether the plugin is currently active.
    """

    name: str = ""
    version: str = ""
    description: str = ""
    enabled: bool = False

    async def init(self) -> None:
        """One-time setup after discovery. Called once at startup.
        Do NOT start background work here — use start() for that.
        """

    async def start(self) -> None:
        """Start the plugin's background activity (e.g. poll loops).
        Called when the plugin is enabled (either at startup or on-demand).
        """

    async def stop(self) -> None:
        """Gracefully stop all background activity.
        Called when the plugin is disabled or during shutdown.
        """

    async def get_status(self) -> dict:
        """Return a status dict for the frontend plugin panel.
        Must at least include {"enabled": self.enabled}.
        """
        return {"enabled": self.enabled}

    async def get_config_schema(self) -> dict:
        """Return a JSON Schema describing the plugin's config fields.
        Return an empty dict if the plugin has no user-configurable options.
        """
        return {}
