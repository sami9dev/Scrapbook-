package resolver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"go-telegram-bot/internal/cache"
)

type Result struct {
	SourceURL   string
	Destination string
	Title       string
	FromCache   bool
	Duration    time.Duration
	Err         error
}

type StoredLink struct {
	ID          string `json:"_id"`
	SourceURL   string `json:"sourceUrl"`
	Title       string `json:"title"`
	Filename    string `json:"filename"`
	Scope       string `json:"scope"`
	Season      int    `json:"season"`
	Episode     int    `json:"episode"`
	Quality     string `json:"quality"`
	ProviderURL string `json:"providerUrl"`
	MediatorURL string `json:"mediatorUrl"`
	Status      string `json:"status"`
	SizeDisplay string `json:"sizeDisplay"`
}

type SeriesResult struct {
	Title    string
	URL      string
	IsMovie  bool
	Total    int
	Packs    []StoredLink
	Episodes []StoredLink
}

type Resolver struct {
	cache       *cache.MemoryCache
	httpClient  *http.Client
	resolverAPI string
	baseAPI     string
}

func New(c *cache.MemoryCache, localResolverAPI string, timeout time.Duration) *Resolver {
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:        200,
		MaxIdleConnsPerHost: 50,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
	}

	baseAPI := "http://localhost:3000"
	if idx := strings.Index(localResolverAPI, "/api/"); idx != -1 {
		baseAPI = localResolverAPI[:idx]
	}

	return &Resolver{
		cache:       c,
		httpClient:  client,
		resolverAPI: localResolverAPI,
		baseAPI:     baseAPI,
	}
}

// IsContentPage returns true if the URL is a series or movie landing page rather than a download mediator
func (r *Resolver) IsContentPage(rawURL string) bool {
	lower := strings.ToLower(rawURL)
	return (strings.Contains(lower, "/series/") || strings.Contains(lower, "/movies/")) && !strings.Contains(lower, "/download/")
}

func (r *Resolver) fetchAllStoredLinks(ctx context.Context) []StoredLink {
	reqURL := fmt.Sprintf("%s/api/links?limit=500", r.baseAPI)
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil
	}
	resp, err := r.httpClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	var allItems []StoredLink
	_ = json.NewDecoder(resp.Body).Decode(&allItems)
	return allItems
}

// GetSeriesReleases looks up all releases, season packs, and episodes for a movie/series page
func (r *Resolver) GetSeriesReleases(ctx context.Context, rawURL string) (*SeriesResult, error) {
	allItems := r.fetchAllStoredLinks(ctx)

	normQuery := strings.TrimRight(strings.ToLower(rawURL), "/")
	slug := extractSlug(normQuery)
	var matched []StoredLink

	for _, item := range allItems {
		itemSrc := strings.TrimRight(strings.ToLower(item.SourceURL), "/")
		if itemSrc == normQuery || (slug != "" && strings.Contains(itemSrc, slug)) {
			matched = append(matched, item)
		}
	}

	// If not found in DB, auto-scrape on-demand!
	if len(matched) == 0 {
		log.Printf("[Auto-Scrape] Initiating on-demand scrape for: %s", rawURL)
		scrapeCtx, cancel := context.WithTimeout(ctx, 75*time.Second)
		defer cancel()

		scraperDir := os.Getenv("SCRAPER_DIR")
		if scraperDir == "" {
			scraperDir = "C:\\Users\\sk621\\scraper"
		}
		scriptPath := filepath.Join(scraperDir, "scratch", "scrape_url.js")

		cmd := exec.CommandContext(scrapeCtx, "node", scriptPath, rawURL)
		cmd.Dir = scraperDir
		setSysProcAttr(cmd)
		out, err := cmd.CombinedOutput()
		if err != nil {
			log.Printf("[Auto-Scrape] Failed: %v | Output: %s", err, string(out))
		} else {
			log.Printf("[Auto-Scrape] Completed: %s", string(out))
		}

		// Re-fetch after scrape
		allItems = r.fetchAllStoredLinks(ctx)
		for _, item := range allItems {
			itemSrc := strings.TrimRight(strings.ToLower(item.SourceURL), "/")
			if itemSrc == normQuery || (slug != "" && strings.Contains(itemSrc, slug)) {
				matched = append(matched, item)
			}
		}
	}

	if len(matched) == 0 {
		return nil, errors.New("no releases found for this title yet. Please scrape this URL first.")
	}

	isMovie := strings.Contains(strings.ToLower(rawURL), "/movies/") || matched[0].Scope == "movie"

	sr := &SeriesResult{
		Title:   extractDisplayTitle(matched[0].Title),
		URL:     rawURL,
		IsMovie: isMovie,
		Total:   len(matched),
	}

	for _, m := range matched {
		if m.Scope == "pack" {
			sr.Packs = append(sr.Packs, m)
		} else {
			sr.Episodes = append(sr.Episodes, m)
		}
	}

	return sr, nil
}

func extractSlug(urlStr string) string {
	parts := strings.Split(urlStr, "/")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return urlStr
}

func extractDisplayTitle(rawTitle string) string {
	for _, sep := range []string{"S0", "2160p", "1080p", "720p", "480p", "("} {
		if idx := strings.Index(strings.ToLower(rawTitle), strings.ToLower(sep)); idx != -1 {
			rawTitle = rawTitle[:idx]
		}
	}
	cleaned := strings.Trim(rawTitle, " .-_()[]")
	if cleaned == "" {
		return "Title"
	}
	return cleaned
}

func isIntermediateMediator(urlStr string) bool {
	lower := strings.ToLower(urlStr)
	return strings.Contains(lower, "latestnewsonline.sbs") || strings.Contains(lower, "link.xdmovies.")
}

// Resolve processes an individual URL, checking cache first, then resolving
func (r *Resolver) Resolve(ctx context.Context, rawURL string) Result {
	rawURL = strings.TrimSpace(rawURL)
	start := time.Now()

	// 1. Check In-Memory Cache (Sub-millisecond lookup)
	if cached, hit := r.cache.Get(rawURL); hit {
		return Result{
			SourceURL:   rawURL,
			Destination: cached.Destination,
			Title:       cached.Title,
			FromCache:   true,
			Duration:    time.Since(start),
			Err:         nil,
		}
	}

	// 2. Resolve via Local Scraper Daemon (with browser & Turnstile engine)
	dest, title, err := r.resolveViaBackend(ctx, rawURL)
	if err != nil {
		// Auto-retry once after a short 2-second pause if first attempt failed/timed out
		log.Printf("[Resolver] First attempt failed for %s (%v). Auto-retrying once...", rawURL, err)
		time.Sleep(2 * time.Second)
		dest, title, err = r.resolveViaBackend(ctx, rawURL)
	}
	if err != nil {
		// Fallback: Attempt direct HTTP redirect inspection
		dest, err = r.resolveDirectRedirects(ctx, rawURL)
	}

	if title == "" {
		allItems := r.fetchAllStoredLinks(ctx)
		for _, item := range allItems {
			if strings.EqualFold(item.MediatorURL, rawURL) || (dest != "" && strings.EqualFold(item.ProviderURL, dest)) {
				if item.Filename != "" {
					title = item.Filename
					break
				} else if item.Title != "" {
					title = item.Title
					break
				}
			}
		}
	}

	duration := time.Since(start)

	if err == nil && dest != "" && !isIntermediateMediator(dest) {
		// Save to cache for instant future lookups
		r.cache.Set(rawURL, dest, title)
		return Result{
			SourceURL:   rawURL,
			Destination: dest,
			Title:       title,
			FromCache:   false,
			Duration:    duration,
			Err:         nil,
		}
	}

	if isIntermediateMediator(dest) {
		err = errors.New("timed out waiting for final HubCloud destination")
	}

	return Result{
		SourceURL: rawURL,
		Duration:  duration,
		Err:       err,
	}
}

type resolveRequest struct {
	MediatorURL string `json:"mediatorUrl"`
}

type resolveResponse struct {
	Success     bool   `json:"success"`
	Destination string `json:"destination"`
	DriveID     string `json:"driveId"`
	Title       string `json:"title"`
	Error       string `json:"error"`
}

func (r *Resolver) resolveViaBackend(ctx context.Context, targetURL string) (string, string, error) {
	payload, _ := json.Marshal(resolveRequest{MediatorURL: targetURL})
	req, err := http.NewRequestWithContext(ctx, "POST", r.resolverAPI, bytes.NewBuffer(payload))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("backend request failed: %w", err)
	}
	defer resp.Body.Close()

	var result resolveResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", fmt.Errorf("failed to decode response: %w", err)
	}

	if !result.Success || result.Destination == "" {
		errMsg := result.Error
		if errMsg == "" {
			errMsg = "resolution unsuccessful"
		}
		return "", "", errors.New(errMsg)
	}

	return result.Destination, result.Title, nil
}

func (r *Resolver) resolveDirectRedirects(ctx context.Context, targetURL string) (string, error) {
	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Timeout: 10 * time.Second,
	}

	current := targetURL
	for i := 0; i < 5; i++ {
		req, err := http.NewRequestWithContext(ctx, "GET", current, nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

		resp, err := client.Do(req)
		if err != nil {
			return "", err
		}
		resp.Body.Close()

		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			loc := resp.Header.Get("Location")
			if loc != "" {
				current = loc
				continue
			}
		}
		break
	}

	if current != targetURL && !isIntermediateMediator(current) {
		return current, nil
	}
	return "", errors.New("resolution failed or timed out during challenge verification")
}
