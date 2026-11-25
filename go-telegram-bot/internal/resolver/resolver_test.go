package resolver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestExtractSlugTitleAndNormalize(t *testing.T) {
	got := extractSlugTitle("delhi-crime-2160p-1080p-hindi-english-download-87508")
	if got != "delhi crime" {
		t.Fatalf("expected 'delhi crime', got %q", got)
	}
	got2 := extractSlugTitle("dhindora-2160p-1080p-hindi-download-275204")
	if got2 != "dhindora" {
		t.Fatalf("expected 'dhindora', got %q", got2)
	}
}

func TestIsZipPackAndCloudflareErrorSafe(t *testing.T) {
	packLink := StoredLink{
		Scope:    "pack",
		Filename: "Delhi.Crime.S01.2160p.NF.WEB-DL-XDMovies.com.zip",
	}
	if !isZipPack(packLink) {
		t.Fatalf("expected pack scope + .zip to be classified as zip pack")
	}

	epLink := StoredLink{
		Scope:    "episode",
		Filename: "Delhi.Crime.S01E01.1080p.mkv",
	}
	if isZipPack(epLink) {
		t.Fatalf("expected .mkv episode not to be classified as zip pack")
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/links":
			_ = json.NewEncoder(w).Encode([]StoredLink{})
		case "/api/scrape-page":
			_ = json.NewEncoder(w).Encode(scrapePageResponse{
				Success:   false,
				Challenge: true,
				Error:     "Target page is gated by Cloudflare",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	resEngine := New(nil, srv.URL+"/api/resolve-link", "", "", 10*time.Second)
	_, err := resEngine.GetSeriesReleases(context.Background(), "https://huh.xdmovies.wtf/series/delhi-crime-2160p-1080p-hindi-english-download-87508")
	if err == nil {
		t.Fatalf("expected Cloudflare error, got nil")
	}
	if strings.Contains(err.Error(), "<title>") {
		t.Fatalf("Cloudflare error message must not contain raw <title> tag for Telegram HTML mode: %q", err.Error())
	}
}

func TestSearchByTitleAndSlugFallbackMatching(t *testing.T) {
	samplePacks := []StoredLink{
		{
			ID:          "1",
			SourceURL:   "https://huh.xdmovies.wtf/",
			Title:       "Delhi.Crime.S01.2160p.WEB-DL.zip",
			Filename:    "Delhi.Crime.S01.2160p.WEB-DL.zip",
			Scope:       "pack",
			Season:      1,
			Quality:     "2160p",
			MediatorURL: "https://link.xdmovies.wtf/download/dc1",
		},
		{
			ID:          "2",
			SourceURL:   "https://4khdhub.one/the-good-lawyer-movie-8524/",
			Title:       "The.Good.Lawyer.2025.1080p.mkv",
			Filename:    "The.Good.Lawyer.2025.1080p.mkv",
			Scope:       "movie",
			Quality:     "1080p",
			MediatorURL: "https://4khdhub.one/dl/tgl",
		},
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/links" {
			// Simulate empty targeted query on first two calls, then return full list on limit=500 fallback
			if r.URL.Query().Get("sourceUrl") != "" || r.URL.Query().Get("titleSearch") != "" {
				_ = json.NewEncoder(w).Encode([]StoredLink{})
				return
			}
			_ = json.NewEncoder(w).Encode(samplePacks)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	resEngine := New(nil, srv.URL+"/api/resolve-link", "", "", 10*time.Second)

	sr, err := resEngine.SearchByTitle(context.Background(), "Delhi Crime")
	if err != nil {
		t.Fatalf("SearchByTitle failed: %v", err)
	}
	if len(sr.Packs) != 1 || sr.Packs[0].ID != "1" {
		t.Fatalf("expected 1 Delhi Crime pack, got %+v", sr.Packs)
	}

	sr2, err := resEngine.GetSeriesReleases(context.Background(), "https://huh.xdmovies.wtf/series/delhi-crime-2160p-1080p-hindi-english-download-87508")
	if err != nil {
		t.Fatalf("GetSeriesReleases slug fallback failed: %v", err)
	}
	if len(sr2.Packs) != 1 || sr2.Packs[0].ID != "1" {
		t.Fatalf("expected 1 Delhi Crime pack via slug fallback, got %+v", sr2.Packs)
	}
}
