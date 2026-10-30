#!/bin/bash
set -e

APP_PORT="${PORT:-10000}"

echo "=================================================="
echo "⚡ Starting Production Services on Port ${APP_PORT}..."
echo "=================================================="

exec node src/index.js
