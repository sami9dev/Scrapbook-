package main

import (
	"context"
	"fmt"
	"time"

	"go-telegram-bot/internal/cache"
	"go-telegram-bot/internal/resolver"
)

func main() {
	c := cache.New(time.Hour)
	r := resolver.New(c, "http://127.0.0.1:3000/api/resolve-link", "", "", 90*time.Second)

	testUrls := []string{
		"https://huh.xdmovies.wtf/series/campus-drivers-2160p-1080p-hindi-french-download-303044",
	}

	for _, u := range testUrls {
		fmt.Println("\nTesting GetSeriesReleases for:", u)
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		start := time.Now()
		sr, err := r.GetSeriesReleases(ctx, u)
		cancel()

		if err != nil {
			fmt.Printf("❌ Error: %v\n", err)
		} else {
			fmt.Printf("✅ Success: '%s' (Total: %d, Packs: %d, Episodes: %d) took %v\n",
				sr.Title, sr.Total, len(sr.Packs), len(sr.Episodes), time.Since(start))
			
			resolvedCount := 0
			for _, ep := range sr.Episodes {
				if ep.ProviderURL != "" {
					resolvedCount++
				}
			}
			for _, pk := range sr.Packs {
				if pk.ProviderURL != "" {
					resolvedCount++
				}
			}
			fmt.Printf("   🔗 Direct ProviderURL resolved: %d/%d\n", resolvedCount, sr.Total)
			if len(sr.Episodes) > 0 {
				fmt.Printf("   Sample Ep: %s -> %s (Mediator: %s)\n", sr.Episodes[0].Filename, sr.Episodes[0].ProviderURL, sr.Episodes[0].MediatorURL)
			}
		}
	}
}
