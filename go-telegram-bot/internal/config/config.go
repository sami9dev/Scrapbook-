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
	RequestTimeout   time.Duration
}

func Load() *Config {
	_ = godotenv.Load()

	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	workers := getEnvInt("WORKER_CONCURRENCY", 10)
	cacheMinutes := getEnvInt("CACHE_TTL_MINUTES", 1440)
	resolverAPI := os.Getenv("LOCAL_RESOLVER_API")
	if resolverAPI == "" {
		resolverAPI = "http://localhost:3000/api/resolve-link"
	}
	timeoutSec := getEnvInt("REQUEST_TIMEOUT_SECONDS", 45)

	return &Config{
		TelegramBotToken: token,
		WorkerCount:      workers,
		CacheTTL:         time.Duration(cacheMinutes) * time.Minute,
		LocalResolverAPI: resolverAPI,
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
