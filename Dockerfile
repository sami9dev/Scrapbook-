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
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python stealth scraping dependencies
RUN pip3 install --no-cache-dir --break-system-packages \
    scrapling \
    patchright \
    playwright

# Install Playwright browser and dependencies
RUN npx --yes playwright install chromium --with-deps || true
RUN python3 -m patchright install chromium || true

# Copy Node.js package manifests and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Copy compiled Go bot binary from builder stage
COPY --from=go-builder /build/bot /app/go-telegram-bot/bot
RUN chmod +x /app/go-telegram-bot/bot /app/start.sh

# Environment settings
ENV NODE_ENV=production
ENV PORT=10000
ENV SCRAPER_DIR=/app
ENV SCRAPLING_PYTHON=python3
ENV SCRAPLING_BIN=scrapling

EXPOSE 10000

CMD ["/app/start.sh"]
