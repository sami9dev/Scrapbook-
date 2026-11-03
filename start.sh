#!/bin/bash
set -e

export PLAYWRIGHT_BROWSERS_PATH=0
export NODE_OPTIONS="--max-old-space-size=512"
APP_PORT="${PORT:-7860}"

echo "=================================================="
echo "⚡ Starting Production Services on Port ${APP_PORT}..."
echo "=================================================="

exec node src/index.js
