#!/bin/bash
set -e

export PLAYWRIGHT_BROWSERS_PATH=0
APP_PORT="${PORT:-10000}"

echo "=================================================="
echo "⚡ Starting Production Services on Port ${APP_PORT}..."
echo "=================================================="

exec node src/index.js
