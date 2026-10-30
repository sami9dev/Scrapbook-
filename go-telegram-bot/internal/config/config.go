package config

import (
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	TelegramBotToken string
	WorkerCount      int
	CacheTTL         time.Duration
	LocalResolverAPI string
	RustWorkerURL    string
	RequestTimeout   time.Duration
}

func Load() *Config {
	_ = godotenv.Load()

	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	workers := getEnvInt("WORKER_CONCURRENCY", 4)
	cacheMinutes := getEnvInt("CACHE_TTL_MINUTES", 1440)
	resolverAPI := os.Getenv("LOCAL_RESOLVER_API")
	if resolverAPI == "" {
		resolverAPI = os.Getenv("RESOLVER_LOCAL_API")
	}
	if resolverAPI == "" {
		port := os.Getenv("PORT")
		if port != "" {
			resolverAPI = "http://127.0.0.1:" + port + "/api/resolve-link"
		} else {
			resolverAPI = "http://localhost:3000/api/resolve-link"
		}
	}
	rustWorkerURL := os.Getenv("RUST_WORKER_URL")
	if rustWorkerURL == "" {
		rustWorkerURL = os.Getenv("RUST_SERVICE_URL")
	}
	timeoutSec := getEnvInt("REQUEST_TIMEOUT_SECONDS", 150)

	return &Config{
		TelegramBotToken: token,
		WorkerCount:      workers,
		CacheTTL:         time.Duration(cacheMinutes) * time.Minute,
		LocalResolverAPI: resolverAPI,
		RustWorkerURL:    rustWorkerURL,
		RequestTimeout:   time.Duration(timeoutSec) * time.Second,
	}
}

func getEnvInt(key string, defaultVal int) int {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	val, err := strconv.Atoi(v)
	if err != nil {
		return defaultVal
	}
	return val
}
