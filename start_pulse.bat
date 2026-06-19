@echo off
chcp 65001 >nul
title PULSE — 实时数据看板

echo.
echo   ★ PULSE v1.0 — 实时数据看板
echo   ═══════════════════════════════
echo.

:: Check Python
where python >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [错误] 未找到 Python，请安装 Python 3.10+
    pause
    exit /b 1
)

:: Navigate to project root
cd /d "%~dp0"

:: Activate venv or create if missing
if not exist "venv\Scripts\python.exe" (
    echo [Pulse] 首次运行，创建虚拟环境...
    python -m venv venv
    if %ERRORLEVEL% neq 0 (
        echo [错误] 创建虚拟环境失败
        pause
        exit /b 1
    )
    echo [Pulse] 安装依赖...
    call venv\Scripts\activate.bat
    pip install -r backend\requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
    if %ERRORLEVEL% neq 0 (
        echo [错误] 安装依赖失败
        pause
        exit /b 1
    )
    echo [Pulse] 依赖安装完成
) else (
    call venv\Scripts\activate.bat
)

:: Ensure data directory
if not exist "data" mkdir data

:: Start server
echo.
echo   ┌─────────────────────────────────────────┐
echo   │  PULSE 启动中...                         │
echo   │  浏览器访问: http://localhost:8080        │
echo   │  WebSocket:  ws://localhost:8765         │
echo   │  Ctrl+C 停止                             │
echo   └─────────────────────────────────────────┘
echo.

python backend\main.py

pause
