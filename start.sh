#!/bin/bash
set -e

APP_PORT="${PORT:-10000}"

echo "=================================================="
echo "⚡ Starting Production Services on Port ${APP_PORT}..."
echo "=================================================="

# 1. Start Node.js Scraper API Daemon in background
PORT="${APP_PORT}" node src/index.js &
NODE_PID=$!

echo "Waiting for Scraper API health endpoint on port ${APP_PORT}..."
for i in {1..30}; do
  if curl -s "http://127.0.0.1:${APP_PORT}/health" > /dev/null 2>&1; then
    echo "✅ Scraper API is healthy and listening on port ${APP_PORT}!"
    break
  fi
  sleep 1
done

# 2. Start Go Telegram Bot in background
cd /app/go-telegram-bot
export RESOLVER_LOCAL_API="http://127.0.0.1:${APP_PORT}/api/resolve-link"
export LOCAL_RESOLVER_API="http://127.0.0.1:${APP_PORT}/api/resolve-link"
export SCRAPER_DIR="/app"
export WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-5}"

./bot &
BOT_PID=$!
echo "✅ Go Telegram Bot started with PID ${BOT_PID}!"

# 3. Graceful shutdown handler
cleanup() {
  echo "Shutting down gracefully..."
  kill -TERM "$NODE_PID" "$BOT_PID" 2>/dev/null || true
  wait "$NODE_PID" "$BOT_PID" 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "🚀 All services live and operational!"
wait -n "$NODE_PID" "$BOT_PID"
