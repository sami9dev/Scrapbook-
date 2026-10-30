package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"

	"go-telegram-bot/internal/bot"
	"go-telegram-bot/internal/cache"
	"go-telegram-bot/internal/config"
	"go-telegram-bot/internal/pool"
	"go-telegram-bot/internal/resolver"
)

func main() {
	log.Println("==================================================")
	log.Println("⚡ High-Speed Golang Telegram Bot Starting... ⚡")
	log.Println("==================================================")

	cfg := config.Load()

	if cfg.TelegramBotToken == "" || cfg.TelegramBotToken == "123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ" {
		log.Fatal("ERROR: TELEGRAM_BOT_TOKEN is not configured! Please set it in your .env file or environment.")
	}

	// 1. Initialize Thread-Safe In-Memory Cache
	memCache := cache.New(cfg.CacheTTL)
	log.Printf("[Init] Memory Cache configured with TTL: %v\n", cfg.CacheTTL)

	// 2. Initialize Link Resolver (with Rust Worker connection)
	resEngine := resolver.New(memCache, cfg.LocalResolverAPI, cfg.RustWorkerURL, cfg.TelegramBotToken, cfg.RequestTimeout)
	log.Printf("[Init] Resolver Engine connected to: %s (Timeout: %v, Rust Worker: %s)\n", cfg.LocalResolverAPI, cfg.RequestTimeout, cfg.RustWorkerURL)

	// 3. Initialize Concurrency Worker Pool
	queueCapacity := cfg.WorkerCount * 50
	workerPool := pool.New(cfg.WorkerCount, queueCapacity, resEngine)
	log.Printf("[Init] Worker Pool spawned with %d concurrent Goroutines (Queue Buffer: %d)\n", cfg.WorkerCount, queueCapacity)

	// 4. Initialize Telegram Bot
	tgBot, err := bot.New(cfg.TelegramBotToken, workerPool, resEngine, memCache)
	if err != nil {
		log.Fatalf("ERROR: Failed to create Telegram bot: %v\n", err)
	}

	// 5. Handle Graceful Shutdown
	stopChan := make(chan os.Signal, 1)
	signal.Notify(stopChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-stopChan
		log.Println("\n[Shutdown] Shutting down Telegram bot and draining worker pool...")
		tgBot.Stop()
		workerPool.Stop()
		log.Println("[Shutdown] All Goroutines stopped safely. Bye!")
		os.Exit(0)
	}()

	log.Println("🚀 Bot is listening for incoming Telegram messages...")
	tgBot.Start()
}
