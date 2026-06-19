@echo off
REM Start Pulse Python backend
REM Located at src-tauri/scripts/start-backend.bat
REM Project root is two levels up

cd /d "%~dp0..\.."

REM Try venv Python first, fall back to system Python
if exist "venv\Scripts\python.exe" (
    "venv\Scripts\python.exe" backend/main.py
) else (
    python backend/main.py
)

REM Pause on error so the window stays open for diagnostics
if errorlevel 1 (
    echo.
    echo Backend exited with code %errorlevel%
    pause
)
