package bot

import (
	"fmt"
	"strings"
	"testing"

	"go-telegram-bot/internal/resolver"
)

func buildDelhiCrimeFixture() *resolver.SeriesResult {
	counts := []int{5, 4, 4}
	var packs []resolver.StoredLink
	for idx, n := range counts {
		season := idx + 1
		for i := 0; i < n; i++ {
			q := "1080p"
			codec := "H.265"
			switch i {
			case 0:
				q = "2160p"
				codec = "H.265"
			case 1:
				q = "1080p"
				codec = "H.265"
			case 2:
				q = "1080p"
				codec = "H.264"
			case 3:
				q = "720p"
				codec = "H.264"
			case 4:
				q = "480p"
				codec = "H.264"
			}
			fname := fmt.Sprintf("Delhi.Crime.S0%d.%s.NF.WEB-DL.%s-XDMovies.com.zip", season, q, codec)
			packs = append(packs, resolver.StoredLink{
				ID:          fmt.Sprintf("s%d_%d", season, i),
				SourceURL:   "https://huh.xdmovies.wtf/series/delhi-crime-2160p-1080p-hindi-english-download-87508",
				Title:       fname,
				Filename:    fname,
				Scope:       "pack",
				Season:      season,
				Quality:     q,
				SizeDisplay: fmt.Sprintf("%d.5 GB", i+2),
				MediatorURL: fmt.Sprintf("https://link.xdmovies.wtf/download/dc_s%d_%d", season, i),
			})
		}
	}
	return &resolver.SeriesResult{
		Title: "Delhi Crime",
		URL:   "https://huh.xdmovies.wtf/series/delhi-crime-2160p-1080p-hindi-english-download-87508",
		Total: len(packs),
		Packs: packs,
	}
}

func TestZipQualitySummaryAndMenuLimits(t *testing.T) {
	b := &Bot{}
	series := buildDelhiCrimeFixture()

	seasons := getAvailableSeasonsForPacks(series)
	if len(seasons) != 3 {
		t.Fatalf("expected 3 seasons, got %v", seasons)
	}

	s1Qualities := getAvailableZipQualities(series, 1)
	if len(s1Qualities) != 4 {
		t.Fatalf("expected 4 distinct quality groups in S1, got %+v", s1Qualities)
	}
	for _, q := range s1Qualities {
		if q.Tag == "1080p" {
			if q.Count != 2 {
				t.Fatalf("expected S1 1080p count 2, got %d", q.Count)
			}
			if q.Label != "1080p FHD" {
				t.Fatalf("expected grouped 1080p label '1080p FHD', got %q", q.Label)
			}
		}
	}

	menu := b.buildZipNavigatorMenu(makeSeriesKey(series), series)
	for _, row := range menu.InlineKeyboard {
		for _, btn := range row {
			if len(btn.Data) > 64 {
				t.Fatalf("callback data exceeds 64 bytes (%d): %q", len(btn.Data), btn.Data)
			}
		}
	}

	allBlocks := b.formatZipBlocks(series, 0, "all")
	totalRendered := 0
	for _, blk := range allBlocks {
		totalRendered += strings.Count(blk, `href="https://link.xdmovies.wtf/download/`)
	}
	if totalRendered != 13 {
		t.Fatalf("expected 13 zip links rendered across all blocks, got %d", totalRendered)
	}

	s1_1080 := b.formatZipBlocks(series, 1, "1080p")
	count1080 := 0
	for _, blk := range s1_1080 {
		count1080 += strings.Count(blk, `href="https://link.xdmovies.wtf/download/`)
	}
	if count1080 != 2 {
		t.Fatalf("expected 2 S1 1080p zip links rendered, got %d", count1080)
	}
}
