package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"go-telegram-bot/internal/cache"
	"go-telegram-bot/internal/config"
	"go-telegram-bot/internal/resolver"
)

func main() {
	cfg := config.Load()
	memCache := cache.NewMultiTierCacheWithREST(nil, nil, "", "")
	resEngine := resolver.New(memCache, cfg.LocalResolverAPI, cfg.RustWorkerURL, cfg.TelegramBotToken, cfg.RequestTimeout)

	testTitles := []string{"avatar", "the good lawyer"}

	for _, title := range testTitles {
		fmt.Printf("\n=== Testing SearchByTitle for: '%s' ===\n", title)
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		start := time.Now()
		res, err := resEngine.SearchByTitle(ctx, title)
		cancel()

		if err != nil {
			log.Printf("❌ Error searching for '%s': %v\n", title, err)
			continue
		}

		fmt.Printf("✅ Found: '%s' (Total Releases: %d, Packs: %d, Episodes: %d) in %v\n",
			res.Title, res.Total, len(res.Packs), len(res.Episodes), time.Since(start))

		if len(res.Packs) > 0 {
			fmt.Printf("   📦 Sample Pack: %s (%s)\n", res.Packs[0].Filename, res.Packs[0].ProviderURL)
		}
		if len(res.Episodes) > 0 {
			fmt.Printf("   🎞️ Sample Episode: %s (%s)\n", res.Episodes[0].Filename, res.Episodes[0].ProviderURL)
		}
	}
}
