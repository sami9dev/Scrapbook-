package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

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

	// 1. Initialize Multi-Tier Cache (L1 sync.Map -> L2 Redis -> L3 MongoDB)
	var rdb *redis.Client
	if cfg.RedisURL != "" {
		if opt, err := redis.ParseURL(cfg.RedisURL); err == nil {
			rdb = redis.NewClient(opt)
			log.Println("[Init] L2 Redis client initialized")
		} else {
			log.Printf("[Init] Redis URL parse note: %v\n", err)
		}
	}

	var mongoCol *mongo.Collection
	if cfg.MongoURI != "" {
		mCtx, mCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer mCancel()
		if client, err := mongo.Connect(mCtx, options.Client().ApplyURI(cfg.MongoURI)); err == nil {
			mongoCol = client.Database("scraper_db").Collection("scrapedlinks")
			log.Println("[Init] L3 MongoDB Atlas client initialized")
		} else {
			log.Printf("[Init] MongoDB connection note: %v\n", err)
		}
	}

	memCache := cache.NewMultiTierCache(rdb, mongoCol)
	log.Printf("[Init] 3-Tier Cache initialized (L1 sync.Map: active, L2 Redis: %v, L3 Mongo: %v)\n", rdb != nil, mongoCol != nil)

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
