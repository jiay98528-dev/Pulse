#!/bin/bash
# Start Pulse Python backend
# Located at src-tauri/scripts/start-backend.sh
# Project root is two levels up

cd "$(dirname "$0")/../.." || exit 1

if [ -f "venv/bin/python" ]; then
    exec venv/bin/python backend/main.py
elif [ -f "venv/Scripts/python" ]; then
    exec venv/Scripts/python backend/main.py
else
    exec python3 backend/main.py
fi
