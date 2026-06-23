"""SQLite database layer for Pulse."""
import json
import aiosqlite
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List

DB_PATH = Path(__file__).parent.parent / "data" / "pulse.db"


async def init_db():
    """Create tables if they don't exist."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS deepseek_usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                cached_tokens INTEGER DEFAULT 0,
                total_tokens INTEGER DEFAULT 0,
                cost REAL DEFAULT 0.0,
                source_file TEXT DEFAULT '',
                imported_at TEXT DEFAULT ''
            )
        """)
        await _ensure_column(db, "deepseek_usage", "source_file", "TEXT DEFAULT ''")
        await _ensure_column(db, "deepseek_usage", "imported_at", "TEXT DEFAULT ''")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS deepseek_balance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                balance REAL NOT NULL,
                currency TEXT DEFAULT 'CNY'
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS csv_imports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                imported_at TEXT NOT NULL,
                records_count INTEGER DEFAULT 0
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS lan_devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                username TEXT DEFAULT '',
                protocol TEXT DEFAULT 'wmi',
                port INTEGER DEFAULT 0,
                enabled INTEGER DEFAULT 1,
                interval_sec INTEGER DEFAULT 30,
                last_seen TEXT,
                created_at TEXT NOT NULL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS lan_device_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id INTEGER NOT NULL,
                timestamp TEXT NOT NULL,
                data_json TEXT NOT NULL,
                FOREIGN KEY (device_id) REFERENCES lan_devices(id)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS lan_paired_devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                ip TEXT NOT NULL,
                shared_metrics TEXT DEFAULT 'cpu,memory,disk,network',
                persistent_trust INTEGER DEFAULT 0,
                token TEXT DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        await init_devices_table()
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_usage_timestamp
            ON deepseek_usage(timestamp)
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_usage_model
            ON deepseek_usage(model)
        """)
        await db.commit()


async def save_usage_records(records: list):
    """Save Deepseek usage records batch."""
    async with aiosqlite.connect(DB_PATH) as db:
        now = datetime.now(timezone.utc).isoformat()
        await db.executemany(
            "INSERT INTO deepseek_usage (timestamp, model, input_tokens, output_tokens, cached_tokens, total_tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(r.get("timestamp", now), r.get("model", "unknown"),
              r.get("input_tokens", 0),
              r.get("output_tokens", 0),
              r.get("cached_tokens", 0),
              r.get("total_tokens", 0),
              r.get("cost", 0.0)) for r in records]
        )
        await db.commit()


async def _ensure_column(db, table: str, column: str, definition: str) -> None:
    """Add a column to an existing SQLite table when older installs lack it."""
    cursor = await db.execute(f"PRAGMA table_info({table})")
    rows = await cursor.fetchall()
    existing = {row[1] for row in rows}
    if column not in existing:
        await db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


async def save_balance(balance: float, currency: str = "CNY"):
    """Save Deepseek balance snapshot."""
    async with aiosqlite.connect(DB_PATH) as db:
        now = datetime.now(timezone.utc).isoformat()
        await db.execute(
            "INSERT INTO deepseek_balance (timestamp, balance, currency) VALUES (?, ?, ?)",
            (now, balance, currency)
        )
        await db.commit()


async def get_usage_history(days: int = 30, model: Optional[str] = None) -> List[dict]:
    """Get usage history for the last N days."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        query = """
            SELECT timestamp, model, input_tokens, output_tokens,
                   cached_tokens, total_tokens, cost, source_file, imported_at
            FROM deepseek_usage
            WHERE timestamp >= datetime('now', ? || ' days', 'utc')
        """
        params = [f"-{days}"]
        if model:
            query += " AND model = ?"
            params.append(model)
        query += " ORDER BY timestamp ASC"
        cursor = await db.execute(query, params)
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def get_usage_summary(days: int = 1) -> dict:
    """Get aggregated usage summary."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT
                COALESCE(SUM(input_tokens), 0) as total_input,
                COALESCE(SUM(output_tokens), 0) as total_output,
                COALESCE(SUM(cached_tokens), 0) as total_cached,
                COALESCE(SUM(total_tokens), 0) as total_tokens,
                COALESCE(SUM(cost), 0.0) as total_cost
            FROM deepseek_usage
            WHERE timestamp >= datetime('now', ? || ' days', 'utc')
        """, (f"-{days}",))
        row = await cursor.fetchone()
        return dict(row) if row else {}


async def get_model_breakdown(days: int = 1) -> List[dict]:
    """Get per-model breakdown for the period."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT
                model,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(cached_tokens), 0) as cached_tokens,
                COALESCE(SUM(total_tokens), 0) as total_tokens,
                COALESCE(SUM(cost), 0.0) as cost
            FROM deepseek_usage
            WHERE timestamp >= datetime('now', ? || ' days', 'utc')
            GROUP BY model
            ORDER BY total_tokens DESC
        """, (f"-{days}",))
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]



async def import_csv_data(records: list, filename: str) -> int:
    """Import CSV records into the database, skipping duplicates by (timestamp, model)."""
    async with aiosqlite.connect(DB_PATH) as db:
        now = datetime.now(timezone.utc).isoformat()
        count = 0
        for r in records:
            ts = r.get("timestamp", now)
            md = r.get("model", "unknown")
            source_file = r.get("source_file") or filename
            imported_at = r.get("imported_at") or now
            # Dedup: if (timestamp, model) exists and new record has token data
            # while existing has none (cost-only), UPDATE instead of skipping
            cursor = await db.execute(
                "SELECT total_tokens FROM deepseek_usage WHERE timestamp = ? AND model = ?",
                (ts, md)
            )
            row = await cursor.fetchone()
            new_tokens = r.get("total_tokens", 0)
            if row:
                existing_tokens = row[0] or 0
                if new_tokens > 0 and existing_tokens == 0:
                    # Enrich cost-only record with token data from amount CSV
                    await db.execute(
                        """UPDATE deepseek_usage
                           SET input_tokens=?, output_tokens=?, cached_tokens=?,
                               total_tokens=?, cost=MAX(cost,?),
                               source_file=?, imported_at=?
                           WHERE timestamp=? AND model=?""",
                        (
                            r.get("input_tokens", 0),
                            r.get("output_tokens", 0),
                            r.get("cached_tokens", 0),
                            new_tokens,
                            r.get("cost", 0.0),
                            source_file,
                            imported_at,
                            ts,
                            md,
                        )
                    )
                    count += 1
                continue
            await db.execute(
                """INSERT INTO deepseek_usage
                   (timestamp, model, input_tokens, output_tokens, cached_tokens,
                    total_tokens, cost, source_file, imported_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (ts,
                 md,
                 r.get("input_tokens", 0),
                 r.get("output_tokens", 0),
                 r.get("cached_tokens", 0),
                 r.get("total_tokens", 0),
                 r.get("cost", 0.0),
                 source_file,
                 imported_at)
            )
            count += 1
        await db.execute(
            "INSERT INTO csv_imports (filename, imported_at, records_count) VALUES (?, ?, ?)",
            (filename, now, count)
        )
        await db.commit()
        return count


# ── Devices ──────────────────────────────────────────────


async def init_devices_table():
    """Create the devices table if it doesn't exist."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                username TEXT DEFAULT '',
                password TEXT DEFAULT '',
                port INTEGER DEFAULT 135,
                enabled INTEGER DEFAULT 1,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)


async def get_devices() -> list:
    """Get all configured devices."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM devices ORDER BY name ASC")
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def get_device(device_id: int):
    """Get a single device by id, or None if not found."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM devices WHERE id = ?", (device_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def add_device(name: str, host: str, username: str = "",
                     password: str = "", port: int = 135,
                     enabled: int = 1) -> int:
    """Add a new device. Returns the new row id."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "INSERT INTO devices (name, host, username, password, port, enabled) VALUES (?, ?, ?, ?, ?, ?)",
            (name, host, username, password, port, enabled)
        )
        await db.commit()
        return cursor.lastrowid or 0


async def update_device(device_id: int, data: dict) -> bool:
    """Update device fields from a dict. Returns True if any row changed."""
    allowed = {"name", "host", "username", "password", "port", "enabled"}
    updates = {k: v for k, v in data.items() if k in allowed}
    if not updates:
        return False
    sets = ", ".join(f"{k} = ?" for k in updates)
    vals = list(updates.values()) + [device_id]
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(f"UPDATE devices SET {sets} WHERE id = ?", vals)
        await db.commit()
        return cursor.rowcount > 0


async def delete_device(device_id: int) -> bool:
    """Remove a device by id. Returns True if a row was deleted."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("DELETE FROM devices WHERE id = ?", (device_id,))
        await db.commit()
        return cursor.rowcount > 0


# ── LAN Devices ─────────────────────────────────────────


async def get_lan_devices() -> List[dict]:
    """Get all configured LAN devices."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM lan_devices ORDER BY name ASC"
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def add_lan_device(name: str, host: str, username: str = "",
                         protocol: str = "wmi", port: int = 0,
                         interval_sec: int = 30) -> int:
    """Add a new LAN device to monitor."""
    async with aiosqlite.connect(DB_PATH) as db:
        now = datetime.now(timezone.utc).isoformat()
        cursor = await db.execute(
            "INSERT INTO lan_devices (name, host, username, protocol, port, interval_sec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (name, host, username, protocol, port, interval_sec, now)
        )
        await db.commit()
        return cursor.lastrowid or 0


async def update_lan_device(device_id: int, **kwargs) -> bool:
    """Update LAN device fields."""
    allowed = {"name", "host", "username", "protocol", "port",
               "enabled", "interval_sec", "last_seen"}
    updates = {k: v for k, v in kwargs.items() if k in allowed}
    if not updates:
        return False
    sets = ", ".join(f"{k} = ?" for k in updates)
    vals = list(updates.values()) + [device_id]
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(f"UPDATE lan_devices SET {sets} WHERE id = ?", vals)
        await db.commit()
        return cursor.rowcount > 0


async def delete_lan_device(device_id: int) -> bool:
    """Remove a LAN device and its snapshots."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM lan_device_snapshots WHERE device_id = ?", (device_id,))
        await db.execute("DELETE FROM lan_devices WHERE id = ?", (device_id,))
        await db.commit()
        return True


async def save_lan_snapshot(device_id: int, data: dict) -> int:
    """Save a data snapshot from a LAN device."""
    async with aiosqlite.connect(DB_PATH) as db:
        now = datetime.now(timezone.utc).isoformat()
        await db.execute(
            "UPDATE lan_devices SET last_seen = ? WHERE id = ?",
            (now, device_id)
        )
        cursor = await db.execute(
            "INSERT INTO lan_device_snapshots (device_id, timestamp, data_json) VALUES (?, ?, ?)",
            (device_id, now, json.dumps(data, default=str))
        )
        await db.commit()
        return cursor.lastrowid or 0


# ── LAN Paired Devices ────────────────────────────────


async def add_lan_paired_device(device_id: str, name: str, ip: str,
                                shared_metrics: str = "cpu,memory,disk,network",
                                persistent_trust: int = 0,
                                token: str = "") -> int:
    """Add a new paired LAN device. Returns the new row id."""
    async with aiosqlite.connect(DB_PATH) as db:
        now = datetime.now(timezone.utc).isoformat()
        cursor = await db.execute(
            """INSERT OR REPLACE INTO lan_paired_devices
               (device_id, name, ip, shared_metrics, persistent_trust, token, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (device_id, name, ip, shared_metrics, persistent_trust, token, now)
        )
        await db.commit()
        return cursor.lastrowid or 0


async def get_lan_paired_devices() -> list[dict]:
    """Get all paired LAN devices."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM lan_paired_devices ORDER BY name ASC"
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def find_paired_device_by_ip(ip: str) -> Optional[dict]:
    """Find a paired device by IP address."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM lan_paired_devices WHERE ip = ?", (ip,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def find_trusted_device_by_ip(ip: str) -> Optional[dict]:
    """Find a persistent-trust device by IP address."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM lan_paired_devices WHERE ip = ? AND persistent_trust = 1", (ip,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_lan_trusted_devices() -> list[dict]:
    """Get all persistent-trust devices."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM lan_paired_devices WHERE persistent_trust = 1 ORDER BY name ASC"
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def delete_lan_paired_device(device_id: int) -> bool:
    """Remove a paired device by its primary key id. Returns True if a row was deleted."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("DELETE FROM lan_paired_devices WHERE id = ?", (device_id,))
        await db.commit()
        return cursor.rowcount > 0


async def update_lan_paired_device_metrics(device_id: int, shared_metrics: str) -> bool:
    """Update shared_metrics for a paired device."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "UPDATE lan_paired_devices SET shared_metrics = ? WHERE id = ?",
            (shared_metrics, device_id)
        )
        await db.commit()
        return cursor.rowcount > 0
