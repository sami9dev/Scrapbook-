#!/bin/bash
set -e

export PLAYWRIGHT_BROWSERS_PATH=0
export NODE_OPTIONS="--max-old-space-size=192"
APP_PORT="${PORT:-7860}"

if [ -d "/root/.cache/ms-playwright" ] && [ ! -d "/usr/local/lib/python3.11/dist-packages/patchright/driver/package/.local-browsers" ]; then
    mkdir -p /usr/local/lib/python3.11/dist-packages/patchright/driver/package/.local-browsers
    cp -r /root/.cache/ms-playwright/* /usr/local/lib/python3.11/dist-packages/patchright/driver/package/.local-browsers/ 2>/dev/null || true
fi

echo "=================================================="
echo "⚡ Starting Production Services on Port ${APP_PORT}..."
echo "=================================================="

exec node src/index.js
