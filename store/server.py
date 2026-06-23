"""Pulse 主题商店 — 独立 FastAPI 后端 (M6.2 支付 + M6.3 邮箱验证)"""
import asyncio, json, os, secrets, hashlib, hmac
from datetime import datetime, timedelta, timezone
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import aiosqlite

DB_PATH = Path(__file__).parent / "store.db"


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


STORE_HOST = os.getenv("PULSE_STORE_HOST", "127.0.0.1")
STORE_PORT = int(os.getenv("PULSE_STORE_PORT", "8081"))
STORE_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "PULSE_STORE_ALLOWED_ORIGINS",
        "http://127.0.0.1:8080,http://localhost:8080,"
        "http://tauri.localhost,https://tauri.localhost,tauri://localhost",
    ).split(",")
    if origin.strip()
]

# ── 支付/恢复配置 ──────────────────────────────────────────
SIMULATED_PAYMENTS = _env_bool("PULSE_STORE_SIMULATED_PAYMENTS", False)
SIMULATED_PAYMENT_DELAY = int(os.getenv("PULSE_STORE_SIMULATED_PAYMENT_DELAY", "15"))
DEBUG_RESTORE_CODES = _env_bool("PULSE_STORE_DEBUG_RESTORE_CODES", False)
WECHAT_MCH_ID = os.getenv("PULSE_STORE_WECHAT_MCH_ID", "")
ALIPAY_APP_ID = os.getenv("PULSE_STORE_ALIPAY_APP_ID", "")
PAYMENT_SIGN_KEY = os.getenv("PULSE_STORE_PAYMENT_SIGN_KEY", "")


@asynccontextmanager
async def lifespan(app):
    payment_task = None
    await init_db()
    await seed_themes()
    if SIMULATED_PAYMENTS:
        payment_task = asyncio.create_task(simulate_payment_loop())
    yield
    if payment_task:
        payment_task.cancel()
        try:
            await payment_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Pulse 主题商店", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=STORE_ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Pydantic 模型 ────────────────────────────────────────


class BuyRequest(BaseModel):
    email: str
    payment_method: str = ""  # "wechat" | "alipay"
    payment: str = ""


class RestoreRequest(BaseModel):
    email: str


class RestoreVerifyRequest(BaseModel):
    email: str
    code: str


class WebhookPayload(BaseModel):
    purchase_id: int
    transaction_id: str
    amount: float
    sign: str = ""


# ── 数据库初始化 ─────────────────────────────────────────


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS themes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                author TEXT NOT NULL,
                description TEXT DEFAULT '',
                type TEXT DEFAULT 'community',
                price REAL DEFAULT 0.0,
                tags TEXT DEFAULT '[]',
                download_url TEXT DEFAULT '',
                preview_url TEXT DEFAULT '',
                sponsor_url TEXT DEFAULT '',
                downloads INTEGER DEFAULT 0,
                rating REAL DEFAULT 0.0,
                created_at TEXT DEFAULT (datetime('now')),
                approved INTEGER DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS purchases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                theme_id INTEGER NOT NULL,
                transaction_id TEXT UNIQUE,
                amount REAL DEFAULT 0.0,
                status TEXT DEFAULT 'pending',
                payment_method TEXT DEFAULT '',
                qr_code_url TEXT DEFAULT '',
                expires_at TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (theme_id) REFERENCES themes(id)
            );
            CREATE TABLE IF NOT EXISTS verification_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                code TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                used INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_purchases_email ON purchases(email);
            CREATE INDEX IF NOT EXISTS idx_verification_codes_email ON verification_codes(email);
        """)
        await db.commit()


# ── 后台模拟支付 ──────────────────────────────────────────


async def simulate_payment_loop():
    """后台任务: 轮询 pending 状态的 purchase, 15 秒后自动标记为 paid"""
    while True:
        try:
            async with aiosqlite.connect(DB_PATH) as db:
                now = datetime.now(timezone.utc).isoformat()
                cursor = await db.execute(
                    "SELECT id, email, theme_id, amount FROM purchases WHERE status='pending' AND expires_at > ?",
                    (now,),
                )
                rows = await cursor.fetchall()
                for row in rows:
                    pid, email, theme_id, amount = row
                    # 检查是否已超过模拟延迟时间 (由创建时间 + SIMULATED_PAYMENT_DELAY 决定)
                    created_cursor = await db.execute(
                        "SELECT created_at FROM purchases WHERE id=?", (pid,)
                    )
                    created_row = await created_cursor.fetchone()
                    if created_row:
                        created_at = datetime.fromisoformat(created_row[0])
                        if (datetime.now(timezone.utc) - created_at).total_seconds() >= SIMULATED_PAYMENT_DELAY:
                            tx_id = f"TX-{pid}-{secrets.token_hex(4).upper()}"
                            await db.execute(
                                "UPDATE purchases SET status='paid', transaction_id=? WHERE id=? AND status='pending'",
                                (tx_id, pid),
                            )
                            # 增加主题下载量
                            await db.execute(
                                "UPDATE themes SET downloads=downloads+1 WHERE id=?",
                                (theme_id,),
                            )
                            await db.commit()
                            print(f"[Store] 模拟支付完成: purchase#{pid} -> {tx_id}")
        except Exception as e:
            print(f"[Store] simulate_payment_loop error: {e}")
        await asyncio.sleep(5)


# ── 辅助函数 ──────────────────────────────────────────────


def generate_qr_code_url(purchase_id: int, method: str) -> str:
    """生成模拟 QR 码 URL。仅在显式开启模拟支付时可用。"""
    if not SIMULATED_PAYMENTS:
        raise HTTPException(503, "支付服务未配置")
    if method == "wechat":
        return f"https://pay.weixin.qq.com/qr/fake?purchase_id={purchase_id}"
    elif method == "alipay":
        return f"https://qr.alipay.com/fake?purchase_id={purchase_id}"
    return ""


def generate_verification_code() -> str:
    """生成 6 位数字验证码"""
    return f"{secrets.randbelow(1000000):06d}"


def compute_sign(purchase_id: int, transaction_id: str, amount: float) -> str:
    """计算支付回调签名"""
    if not PAYMENT_SIGN_KEY:
        raise HTTPException(503, "支付回调签名密钥未配置")
    raw = f"{purchase_id}:{transaction_id}:{amount}:{PAYMENT_SIGN_KEY}"
    return hmac.new(PAYMENT_SIGN_KEY.encode(), raw.encode(), hashlib.sha256).hexdigest()


# ── Theme CRUD ────────────────────────────────────────────


@app.get("/v1/themes")
async def list_themes(type_filter: str = None):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        query = "SELECT * FROM themes WHERE approved=1"
        params = []
        if type_filter:
            query += " AND type=?"
            params.append(type_filter)
        query += " ORDER BY downloads DESC"
        cursor = await db.execute(query, params)
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


@app.get("/v1/themes/{theme_id}")
async def get_theme(theme_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM themes WHERE id=?", (theme_id,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404)
        return dict(row)


# ── 6.2 支付端点 ─────────────────────────────────────────


@app.post("/v1/themes/{theme_id}/buy")
async def buy_theme(theme_id: int, req: BuyRequest):
    """创建购买订单。默认发行配置下，付费主题需先配置真实或模拟支付。"""
    payment_method = req.payment_method or req.payment
    # 验证支付方式
    if payment_method not in ("wechat", "alipay"):
        raise HTTPException(400, "payment_method 必须是 wechat 或 alipay")

    # 验证主题存在
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM themes WHERE id=?", (theme_id,))
        theme = await cursor.fetchone()
        if not theme:
            raise HTTPException(404, "主题不存在")
        if theme["price"] <= 0:
            raise HTTPException(400, "免费主题无需购买")
        if not SIMULATED_PAYMENTS and not (WECHAT_MCH_ID or ALIPAY_APP_ID):
            raise HTTPException(503, "支付服务未配置")

        # 检查是否已购买过
        cursor = await db.execute(
            "SELECT id FROM purchases WHERE email=? AND theme_id=? AND status='paid'",
            (req.email, theme_id),
        )
        existing = await cursor.fetchone()
        if existing:
            raise HTTPException(409, "该主题已购买过")

        # 创建 purchase 记录
        expires_at = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
        cursor = await db.execute(
            """INSERT INTO purchases (email, theme_id, amount, status, payment_method, qr_code_url, expires_at)
               VALUES (?, ?, ?, 'pending', ?, ?, ?)""",
            (
                req.email,
                theme_id,
                theme["price"],
                payment_method,
                "",
                expires_at,
            ),
        )
        purchase_id = cursor.lastrowid

        # 生成 QR 码 URL
        qr_url = generate_qr_code_url(purchase_id, payment_method)
        await db.execute(
            "UPDATE purchases SET qr_code_url=? WHERE id=?",
            (qr_url, purchase_id),
        )
        await db.commit()

    return {
        "purchase_id": purchase_id,
        "qr_code_url": qr_url,
        "expires_at": expires_at,
        "amount": theme["price"],
        "payment_method": payment_method,
    }


@app.get("/v1/purchases/{purchase_id}")
async def get_purchase(purchase_id: int):
    """查询购买状态 (前端每 3 秒轮询)"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """SELECT p.*, t.name as theme_name, t.price as theme_price
               FROM purchases p
               LEFT JOIN themes t ON p.theme_id = t.id
               WHERE p.id=?""",
            (purchase_id,),
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, "购买记录不存在")
        result = dict(row)
        # 检查是否过期
        if result["status"] == "pending":
            expires = datetime.fromisoformat(result["expires_at"])
            if datetime.now(timezone.utc) > expires:
                async with aiosqlite.connect(DB_PATH) as db2:
                    await db2.execute(
                        "UPDATE purchases SET status='expired' WHERE id=? AND status='pending'",
                        (purchase_id,),
                    )
                    await db2.commit()
                result["status"] = "expired"
        return result


@app.post("/v1/payments/webhook")
async def payment_webhook(payload: WebhookPayload, request: Request):
    """微信/支付宝异步回调 (开发环境: 直接验证签名后更新状态)

    生产环境替换为微信/支付宝 SDK 验证:
    - 微信: 使用 wechatpay-python-sdk 验证签名
    - 支付宝: 使用 alipay-sdk-python 验证通知
    """
    async with aiosqlite.connect(DB_PATH) as db:
        # 验证签名
        if not payload.sign:
            raise HTTPException(400, "缺少签名")
        expected_sign = compute_sign(payload.purchase_id, payload.transaction_id, payload.amount)
        if not hmac.compare_digest(payload.sign, expected_sign):
            raise HTTPException(400, "签名验证失败")

        # 更新 purchase 状态
        cursor = await db.execute(
            "SELECT status FROM purchases WHERE id=?",
            (payload.purchase_id,),
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, "购买记录不存在")
        if row[0] == "paid":
            return {"ok": True, "message": "已支付, 无需重复回调"}

        await db.execute(
            """UPDATE purchases
               SET status='paid', transaction_id=?
               WHERE id=? AND status='pending'""",
            (payload.transaction_id, payload.purchase_id),
        )
        # 获取 theme_id 更新下载量
        cursor = await db.execute(
            "SELECT theme_id FROM purchases WHERE id=?", (payload.purchase_id,)
        )
        purchase = await cursor.fetchone()
        if purchase:
            await db.execute(
                "UPDATE themes SET downloads=downloads+1 WHERE id=?",
                (purchase[0],),
            )
        await db.commit()

    return {"ok": True, "message": "支付成功"}


# ── 6.3 邮箱验证端点 ─────────────────────────────────────


@app.post("/v1/restore")
async def send_verification_code(req: RestoreRequest):
    """发送邮箱验证码。调试回显必须通过环境变量显式开启。"""
    email = req.email.strip().lower()
    if not email:
        raise HTTPException(400, "邮箱不能为空")
    if not DEBUG_RESTORE_CODES:
        raise HTTPException(503, "邮箱发送服务未配置")

    code = generate_verification_code()
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=3)).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        # 将旧验证码标记为已使用
        await db.execute(
            "UPDATE verification_codes SET used=1 WHERE email=? AND used=0",
            (email,),
        )
        # 插入新验证码
        await db.execute(
            "INSERT INTO verification_codes (email, code, expires_at) VALUES (?, ?, ?)",
            (email, code, expires_at),
        )
        await db.commit()

    print(f"[Store] 验证码已发送到 {email}: {code}")

    response = {
        "ok": True,
        "message": "验证码已发送",
    }
    return response


@app.post("/v1/restore/verify")
async def verify_code(req: RestoreVerifyRequest):
    """验证邮箱验证码, 返回已购主题列表"""
    email = req.email.strip().lower()
    code = req.code.strip()
    if not email or not code:
        raise HTTPException(400, "邮箱和验证码不能为空")

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # 查找有效验证码
        now = datetime.now(timezone.utc).isoformat()
        cursor = await db.execute(
            """SELECT id FROM verification_codes
               WHERE email=? AND code=? AND expires_at>? AND used=0
               ORDER BY id DESC LIMIT 1""",
            (email, code, now),
        )
        vc_row = await cursor.fetchone()
        if not vc_row:
            raise HTTPException(400, "验证码无效或已过期")

        # 标记验证码为已使用
        await db.execute(
            "UPDATE verification_codes SET used=1 WHERE id=?",
            (vc_row["id"],),
        )

        # 查询该邮箱所有已购主题
        cursor = await db.execute(
            """SELECT p.id as purchase_id, p.theme_id, p.status, p.amount,
                      p.created_at as purchased_at,
                      t.name as theme_name, t.version, t.author, t.download_url, t.preview_url
               FROM purchases p
               JOIN themes t ON p.theme_id = t.id
               WHERE p.email=? AND p.status='paid'
               ORDER BY p.created_at DESC""",
            (email,),
        )
        purchases = [dict(r) for r in await cursor.fetchall()]
        await db.commit()

    themes = []
    for item in purchases:
        themes.append({
            "id": item["theme_id"],
            "name": item["theme_name"],
            "version": item["version"],
            "author": item["author"],
            "download_url": item["download_url"],
            "preview_url": item["preview_url"],
            "purchase_id": item["purchase_id"],
            "purchased_at": item["purchased_at"],
        })

    return {
        "ok": True,
        "email": email,
        "purchases": purchases,
        "themes": themes,
    }


# ── 种子数据 ──────────────────────────────────────────────


async def seed_themes():
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("SELECT COUNT(*) FROM themes")
        count = (await cursor.fetchone())[0]
        if count == 0:
            defaults = [
                ("苏维埃构成主义", "1.0.0", "Pulse Team",
                 "1920s 工业美学 · 红/黑/白", "official", 0,
                 '["dark","industrial"]', "", "", ""),
                ("暗夜黑", "1.0.0", "Pulse Team",
                 "极简暗色主题 · 低视觉疲劳", "official", 0,
                 '["dark","minimal"]', "", "", ""),
                ("极简白", "1.0.0", "Pulse Team",
                 "明亮清新 · 适合日间使用", "official", 0,
                 '["light","minimal"]', "", "", ""),
                ("赛博朋克 2077", "1.0.0", "Pulse Team",
                 "霓虹灯效 · 赛博美学", "official", 6.99,
                 '["dark","cyberpunk"]', "", "", ""),
                ("工业红", "1.0.0", "Community Artist",
                 "重工业风 · 锈红配色", "community", 0,
                 '["dark","industrial"]', "", "", ""),
            ]
            await db.executemany(
                """INSERT INTO themes
                   (name,version,author,description,type,price,tags,
                    download_url,preview_url,sponsor_url)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                defaults,
            )
            await db.commit()


if __name__ == "__main__":
    import uvicorn

    print(f"[Store] Starting on http://{STORE_HOST}:{STORE_PORT}")
    uvicorn.run(app, host=STORE_HOST, port=STORE_PORT)
