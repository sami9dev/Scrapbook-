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
	"net/url"
	"os"
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
	cache         *cache.MemoryCache
	httpClient    *http.Client
	resolverAPI   string
	baseAPI       string
	rustWorkerURL string
	botToken      string
}

func New(c *cache.MemoryCache, localResolverAPI string, rustWorkerURL string, botToken string, timeout time.Duration) *Resolver {
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
		cache:         c,
		httpClient:    client,
		resolverAPI:   localResolverAPI,
		baseAPI:       baseAPI,
		rustWorkerURL: strings.TrimRight(rustWorkerURL, "/"),
		botToken:      botToken,
	}
}

// IsContentPage returns true if the URL is a series or movie landing page rather than a download mediator
func (r *Resolver) IsContentPage(rawURL string) bool {
	lower := strings.ToLower(rawURL)
	return (strings.Contains(lower, "/series/") || strings.Contains(lower, "/movies/")) && !strings.Contains(lower, "/download/")
}

func (r *Resolver) fetchAllStoredLinks(ctx context.Context) []StoredLink {
	if r.baseAPI != "" {
		reqURL := fmt.Sprintf("%s/api/links?limit=500", r.baseAPI)
		if req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil); err == nil {
			if resp, err := r.httpClient.Do(req); err == nil && resp.StatusCode == http.StatusOK {
				defer resp.Body.Close()
				var allItems []StoredLink
				if err := json.NewDecoder(resp.Body).Decode(&allItems); err == nil && len(allItems) > 0 {
					return allItems
				}
			}
		}
	}

	// Instant file fallback: read in_memory_scraped_links.json directly without needing a local node server
	for _, p := range []string{
		"/app/data/in_memory_scraped_links.json",
		"../data/in_memory_scraped_links.json",
		"data/in_memory_scraped_links.json",
		"C:\\Users\\sk621\\scraper\\data\\in_memory_scraped_links.json",
		"../scraper/data/in_memory_scraped_links.json",
	} {
		if data, err := os.ReadFile(p); err == nil {
			var allItems []StoredLink
			if err := json.Unmarshal(data, &allItems); err == nil && len(allItems) > 0 {
				return allItems
			}
		}
	}

	return nil
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

		// 1. First attempt fast scraping & identification via Rust Worker microservice
		if r.rustWorkerURL != "" {
			if sr, err := r.scrapeViaRustWorker(ctx, rawURL); err == nil && sr != nil && sr.Total > 0 {
				log.Printf("[Auto-Scrape] Successfully retrieved %d releases via Rust Worker in %s", sr.Total, rawURL)
				return sr, nil
			} else if err != nil {
				log.Printf("[Auto-Scrape] Rust Worker query notice: %v", err)
			}
		}

		// Never run local browser scraper scripts on Windows to prevent PC freezing
		return nil, errors.New("title is not yet cached. Please allow the Render cloud worker to complete scraping.")
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

	// 1b. PRIORITY 1: Check Upstash Redis Cache BEFORE scraping / resolving
	if r.rustWorkerURL != "" {
		if upstashDest, hit := r.checkUpstashLinkCache(ctx, rawURL); hit && upstashDest != "" {
			t := r.lookupStoredTitle(ctx, rawURL, upstashDest)
			r.cache.Set(rawURL, upstashDest, t)
			return Result{
				SourceURL:   rawURL,
				Destination: upstashDest,
				Title:       t,
				FromCache:   true,
				Duration:    time.Since(start),
				Err:         nil,
			}
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
		title = r.lookupStoredTitle(ctx, rawURL, dest)
	}

	duration := time.Since(start)

	if err == nil && dest != "" && !isIntermediateMediator(dest) {
		// Save to in-memory cache for instant future lookups
		r.cache.Set(rawURL, dest, title)
		// PRIORITY 1: Persist in Upstash Redis cache for global instant retrieval
		if r.rustWorkerURL != "" {
			go r.SaveUpstashLinkCache(rawURL, dest)
		}
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

type rustScrapePayload struct {
	URL string `json:"url"`
}

type rustScrapeRelease struct {
	Title          string `json:"title"`
	MediatorURL    string `json:"mediatorUrl"`
	DestinationURL string `json:"destinationUrl"`
	Quality        string `json:"quality"`
	Scope          string `json:"scope"`
	Season         *int   `json:"season"`
	Episode        *int   `json:"episode"`
	SizeDisplay    string `json:"sizeDisplay"`
}

type rustScrapeResponse struct {
	Success  bool                `json:"success"`
	Title    string              `json:"title"`
	IsMovie  bool                `json:"isMovie"`
	Total    int                 `json:"total"`
	Releases []rustScrapeRelease `json:"releases"`
}

func (r *Resolver) scrapeViaRustWorker(ctx context.Context, rawURL string) (*SeriesResult, error) {
	if r.rustWorkerURL == "" {
		return nil, errors.New("rustWorkerURL not configured")
	}

	payloadBytes, _ := json.Marshal(rustScrapePayload{URL: rawURL})
	reqURL := fmt.Sprintf("%s/api/scrape-and-identify", r.rustWorkerURL)

	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewBuffer(payloadBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("rust worker HTTP %d", resp.StatusCode)
	}

	var res rustScrapeResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}

	if !res.Success || len(res.Releases) == 0 {
		return nil, errors.New("no releases returned by rust worker")
	}

	sr := &SeriesResult{
		Title:   res.Title,
		URL:     rawURL,
		IsMovie: res.IsMovie,
		Total:   res.Total,
	}

	for _, rel := range res.Releases {
		sNum := 1
		if rel.Season != nil {
			sNum = *rel.Season
		}
		epNum := 1
		if rel.Episode != nil {
			epNum = *rel.Episode
		}

		link := StoredLink{
			SourceURL:   rawURL,
			Title:       rel.Title,
			Filename:    rel.Title,
			Scope:       rel.Scope,
			Season:      sNum,
			Episode:     epNum,
			Quality:     rel.Quality,
			ProviderURL: rel.DestinationURL,
			MediatorURL: rel.MediatorURL,
			Status:      "active",
			SizeDisplay: rel.SizeDisplay,
		}

		if rel.Scope == "pack" {
			sr.Packs = append(sr.Packs, link)
		} else {
			sr.Episodes = append(sr.Episodes, link)
		}
	}

	return sr, nil
}

func (r *Resolver) lookupStoredTitle(ctx context.Context, mediatorURL, destURL string) string {
	allItems := r.fetchAllStoredLinks(ctx)
	for _, item := range allItems {
		if strings.EqualFold(item.MediatorURL, mediatorURL) || (destURL != "" && strings.EqualFold(item.ProviderURL, destURL)) {
			if item.Filename != "" {
				return item.Filename
			} else if item.Title != "" {
				return item.Title
			}
		}
	}
	return ""
}

func (r *Resolver) checkUpstashLinkCache(ctx context.Context, mediatorURL string) (string, bool) {
	if r.rustWorkerURL == "" || mediatorURL == "" {
		return "", false
	}
	reqURL := fmt.Sprintf("%s/api/resolve/cache?url=%s", r.rustWorkerURL, url.QueryEscape(mediatorURL))
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return "", false
	}
	resp, err := r.httpClient.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		var res struct {
			Cached      bool   `json:"cached"`
			Destination string `json:"destination"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&res); err == nil && res.Cached && res.Destination != "" {
			return res.Destination, true
		}
	}
	return "", false
}

func (r *Resolver) SaveUpstashLinkCache(mediatorURL, destination string) bool {
	if r.rustWorkerURL == "" || mediatorURL == "" || destination == "" {
		return false
	}
	payload, _ := json.Marshal(map[string]string{
		"mediator_url": mediatorURL,
		"destination":  destination,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	reqURL := fmt.Sprintf("%s/api/resolve/cache-save", r.rustWorkerURL)
	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewBuffer(payload))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	if resp, err := r.httpClient.Do(req); err == nil {
		defer resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	}
	return false
}

type EnqueueJobPayload struct {
	URLs      []string `json:"urls"`
	ChatID    int64    `json:"chat_id,omitempty"`
	MessageID int64    `json:"message_id,omitempty"`
	BotToken  string   `json:"bot_token,omitempty"`
}

type CachedResult struct {
	SourceURL   string `json:"source_url"`
	Destination string `json:"destination"`
	FromCache   bool   `json:"from_cache"`
}

type EnqueueJobResponse struct {
	Success   bool           `json:"success"`
	JobID     string         `json:"job_id"`
	Queued    bool           `json:"queued"`
	AllCached bool           `json:"all_cached"`
	TotalURLs int            `json:"total_urls"`
	Results   []CachedResult `json:"results,omitempty"`
	Message   string         `json:"message"`
}

// EnqueueBatchJob dispatches link jobs to the cloud worker queue on Render and returns promptly
func (r *Resolver) EnqueueBatchJob(ctx context.Context, urls []string, chatID int64, messageID int64) (*EnqueueJobResponse, error) {
	if r.rustWorkerURL == "" {
		return nil, errors.New("rust worker URL not configured")
	}

	payload := EnqueueJobPayload{
		URLs:      urls,
		ChatID:    chatID,
		MessageID: messageID,
		BotToken:  r.botToken,
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	reqURL := fmt.Sprintf("%s/api/jobs/enqueue", r.rustWorkerURL)
	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewBuffer(payloadBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker returned status %d", resp.StatusCode)
	}

	var res EnqueueJobResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}

	return &res, nil
}

