# ==========================================
# Stage 1: Build the Go Telegram Bot Binary
# ==========================================
FROM golang:1.23-bookworm AS go-builder

WORKDIR /build
COPY go-telegram-bot/go.mod go-telegram-bot/go.sum* ./
RUN go mod download || true

COPY go-telegram-bot/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /build/bot ./cmd/bot

# ==========================================
# Stage 2: Final Runtime with Node + Python + Playwright
# ==========================================
FROM node:22-bookworm-slim

# Install Python, curl, and essential system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    tini \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libxkbcommon0 \
    libxshmfence1 \
    libgl1 \
    libgtk-3-0 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=0

# Install Python stealth scraping dependencies
RUN pip3 install --no-cache-dir --break-system-packages \
    "scrapling[fetchers]" \
    curl_cffi \
    msgspec \
    patchright \
    playwright

# Install Playwright browser and dependencies
RUN python3 -m patchright install --with-deps chromium || python3 -m patchright install chromium
RUN npx --yes playwright install chromium --with-deps || true
RUN if [ -d "/root/.cache/ms-playwright" ]; then \
      mkdir -p /usr/local/lib/python3.11/dist-packages/patchright/driver/package/.local-browsers && \
      cp -r /root/.cache/ms-playwright/* /usr/local/lib/python3.11/dist-packages/patchright/driver/package/.local-browsers/ 2>/dev/null || true; \
    fi
RUN if [ -d "/usr/local/lib/python3.11/dist-packages/patchright/driver/package/.local-browsers" ]; then \
      mkdir -p /root/.cache/ms-playwright && \
      cp -r /usr/local/lib/python3.11/dist-packages/patchright/driver/package/.local-browsers/* /root/.cache/ms-playwright/ 2>/dev/null || true; \
    fi

# Copy Node.js package manifests and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Copy compiled Go bot binary from builder stage
COPY --from=go-builder /build/bot /app/go-telegram-bot/bot
RUN chmod -R 777 /app
RUN chmod +x /app/go-telegram-bot/bot /app/start.sh

# Environment settings
ENV NODE_ENV=production
ENV PORT=7860
ENV SCRAPER_DIR=/app
ENV SCRAPLING_PYTHON=python3
ENV SCRAPLING_BIN=scrapling

EXPOSE 7860
EXPOSE 10000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]
