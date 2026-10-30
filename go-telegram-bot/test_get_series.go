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
	r := resolver.New(c, "http://localhost:3000/api/resolve-link", "http://localhost:10000", "", 10*time.Second)
	sr, err := r.GetSeriesReleases(context.Background(), "https://huh.xdmovies.wtf/movies/mirzapur-the-movie-2160p-1080p-hindi-download-1378537")
	if err != nil {
		fmt.Println("Error:", err)
	} else {
		fmt.Printf("Found: %s, Total: %d, Packs: %d, Episodes: %d\n", sr.Title, sr.Total, len(sr.Packs), len(sr.Episodes))
	}
}
