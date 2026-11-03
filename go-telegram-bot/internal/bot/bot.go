package bot

import (
	"context"
	"errors"
	"fmt"
	"html"
	"log"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	tele "gopkg.in/telebot.v3"

	"go-telegram-bot/internal/cache"
	"go-telegram-bot/internal/pool"
	"go-telegram-bot/internal/resolver"
)

var urlRegex = regexp.MustCompile(`https?://[^\s/$.?#].[^\s]*`)

type Bot struct {
	teleBot     *tele.Bot
	pool        *pool.WorkerPool
	resolver    *resolver.Resolver
	cache       *cache.MemoryCache
	resolveSlot chan struct{}
	startTime   time.Time
}

func New(token string, p *pool.WorkerPool, r *resolver.Resolver, c *cache.MemoryCache) (*Bot, error) {
	pref := tele.Settings{
		Token:  token,
		Poller: &tele.LongPoller{Timeout: 10 * time.Second},
	}

	b, err := tele.NewBot(pref)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize telebot: %w", err)
	}

	instance := &Bot{
		teleBot:     b,
		pool:        p,
		resolver:    r,
		cache:       c,
		resolveSlot: make(chan struct{}, p.WorkerCount()),
		startTime:   time.Now(),
	}

	instance.registerHandlers()
	return instance, nil
}

func (b *Bot) Start() {
	b.teleBot.Start()
}

func (b *Bot) Stop() {
	b.teleBot.Stop()
}

func (b *Bot) registerHandlers() {
	b.teleBot.Handle("/start", b.handleStart)
	b.teleBot.Handle("/help", b.handleHelp)
	b.teleBot.Handle("/stats", b.handleStats)
	b.teleBot.Handle("/cache", b.handleCache)
	b.teleBot.Handle(tele.OnText, b.handleText)
}

func (b *Bot) handleStart(c tele.Context) error {
	msg := `⚡ <b>High-Speed Golang Link & Media Bot</b>

Powered by Go Goroutines, Channels, and In-Memory Caching:
• <b>Movies & Series:</b> Send any movie/series URL to get <b>ALL</b> releases with full titles & direct HubCloud links!
• <b>Auto-Scrape:</b> Automatically scrapes new titles on-demand if not yet cached!
• <b>Parallel Shortener Resolver:</b> Resolves mediator links concurrently.
• <b>Microsecond Cache:</b> Stored links return in &lt;1ms.

👉 <b>Try sending:</b>
1. A Movie page:
<code>https://huh.xdmovies.wtf/movies/runner-1080p-720p-hindi-english-download-1377237</code>
2. A Series page:
<code>https://huh.xdmovies.wtf/series/sacred-games-2160p-1080p-hindi-download-79352</code>`
	return c.Send(msg, tele.ModeHTML)
}

func (b *Bot) handleHelp(c tele.Context) error {
	msg := `📖 <b>Usage Guidelines</b>

<b>1. Movie / Series Pages:</b>
Paste any movie or series URL to get all releases and direct download links. If it's a new title, the bot will auto-scrape it on-demand!

<b>2. Download Links:</b>
Paste single or multiple download links (separated by newlines). The bot will dispatch them across parallel Go worker routines and resolve each one to its HubCloud destination!`
	return c.Send(msg, tele.ModeHTML)
}

func (b *Bot) handleCache(c tele.Context) error {
	args := c.Args()
	if len(args) < 2 {
		return c.Send("ℹ️ <b>Manual Cache Ingestion:</b>\n\nWhen a link presents a Cloudflare/Turnstile challenge, open it in your browser to get the final HubCloud URL, then send:\n<code>/cache &lt;mediator_url&gt; &lt;hubcloud_url&gt;</code>\n\nExample:\n<code>/cache https://link.xdmovies.wtf/download/xyz https://hubcloud.ist/drive/abc</code>", tele.ModeHTML)
	}

	mediatorURL := strings.TrimSpace(args[0])
	destinationURL := strings.TrimSpace(args[1])

	if !strings.HasPrefix(mediatorURL, "http") || !strings.HasPrefix(destinationURL, "http") {
		return c.Send("❌ Please provide valid HTTP/HTTPS URLs.", tele.ModeHTML)
	}

	ok := b.resolver.SaveUpstashLinkCache(mediatorURL, destinationURL)
	b.cache.Set(mediatorURL, destinationURL, "Manual Cached")

	if ok {
		return c.Send(fmt.Sprintf("🎯 <b>Link Successfully Cached in Cloud!</b>\n\n<b>Source:</b> <code>%s</code>\n<b>HubCloud Destination:</b> <a href=\"%s\">%s</a>\n\n⚡ <i>This link is now persisted in Upstash Redis and Supabase. Future batch queries will resolve it instantly without challenges!</i>", html.EscapeString(mediatorURL), html.EscapeString(destinationURL), html.EscapeString(destinationURL)), tele.ModeHTML)
	} else {
		return c.Send("⚠️ Cached locally in memory, but cloud worker was unreachable.", tele.ModeHTML)
	}
}

func (b *Bot) handleStats(c tele.Context) error {
	totalCached, hits, misses := b.cache.Stats()

	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	uptime := time.Since(b.startTime).Truncate(time.Second)

	msg := fmt.Sprintf(`📊 <b>Engine & Concurrency Stats</b>

⏱️ <b>Uptime:</b> %s
🧵 <b>Active Goroutines:</b> %d
🧠 <b>Allocated RAM:</b> %.2f MB
⚡ <b>Total Allocations:</b> %.2f MB

💾 <b>Cache Metrics:</b>
• Total Items: %d
• Cache Hits: %d ⚡
• Cache Misses: %d
• Hit Ratio: %.1f%%`,
		uptime,
		runtime.NumGoroutine(),
		float64(m.Alloc)/1024/1024,
		float64(m.TotalAlloc)/1024/1024,
		totalCached,
		hits,
		misses,
		calculateHitRatio(hits, misses),
	)

	return c.Send(msg, tele.ModeHTML)
}

func (b *Bot) handleText(c tele.Context) error {
	text := strings.TrimSpace(c.Text())
	matches := urlRegex.FindAllString(text, -1)

	// 1. If text contains no URL, treat as title search!
	if len(matches) == 0 {
		return b.handleTitleSearch(c, text)
	}

	// 2. Check if the URL is a Series or Movie content page
	firstURL := matches[0]
	if b.resolver.IsContentPage(firstURL) {
		return b.handleContentPage(c, firstURL)
	}

	// 3. Otherwise handle as download mediator links
	return b.handleDownloadLinks(c, matches)
}

func (b *Bot) handleTitleSearch(c tele.Context, query string) error {
	statusMsg, _ := b.teleBot.Send(c.Recipient(), fmt.Sprintf("🔍 <i>Searching catalogue for '<b>%s</b>'...</i>", html.EscapeString(query)), tele.ModeHTML)

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	result, err := b.resolver.SearchByTitle(ctx, query)
	duration := time.Since(start)

	if err != nil {
		if statusMsg != nil {
			_, _ = b.teleBot.Edit(statusMsg, err.Error(), tele.ModeHTML)
			return nil
		}
		return c.Send(err.Error(), tele.ModeHTML)
	}

	return b.displaySeriesOrMovie(c, statusMsg, result, duration)
}

func (b *Bot) handleContentPage(c tele.Context, contentURL string) error {
	statusMsg, _ := b.teleBot.Send(c.Recipient(), "🔍 <i>Querying catalogue (auto-scraping if new)...</i>", tele.ModeHTML)

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	series, err := b.resolver.GetSeriesReleases(ctx, contentURL)
	duration := time.Since(start)

	if err != nil {
		log.Printf("[Bot] GetSeriesReleases error: %v", err)
		errMsg := fmt.Sprintf("ℹ️ <b>Title Not Yet In Pre-Indexed Catalogue</b>\n\nThe landing page (<code>%s</code>) is protected by Cloudflare Turnstile, so automated scraping is paused.\n\n👉 <b>How to get your direct HubCloud links:</b>\n1. Open the page in your browser: <a href=\"%s\">%s</a>\n2. Copy the download link(s) on that page (e.g. <code>https://link.xdmovies.wtf/download/...</code>)\n3. Paste the download link(s) here — the bot will resolve each one to a direct <b>HubCloud</b> link!",
			html.EscapeString(contentURL), html.EscapeString(contentURL), html.EscapeString(contentURL))
		if statusMsg != nil {
			if _, editErr := b.teleBot.Edit(statusMsg, errMsg, tele.ModeHTML); editErr != nil {
				log.Printf("[Bot] Failed to edit statusMsg: %v. Sending direct message...", editErr)
				return c.Send(errMsg, tele.ModeHTML)
			}
			return nil
		}
		return c.Send(errMsg, tele.ModeHTML)
	}

	return b.displaySeriesOrMovie(c, statusMsg, series, duration)
}

func (b *Bot) displaySeriesOrMovie(c tele.Context, statusMsg *tele.Message, series *resolver.SeriesResult, duration time.Duration) error {
	// Case A: Movie
	if series.IsMovie {
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("🎬 <b>%s</b>\n", html.EscapeString(series.Title)))
		sb.WriteString(fmt.Sprintf("⚡ <i>Retrieved in %s</i>\n", formatDuration(duration)))
		sb.WriteString(fmt.Sprintf("📁 <b>Available Releases:</b> %d\n\n", series.Total))
		sb.WriteString("🎬 <b>MOVIE DOWNLOADS (BY QUALITY):</b>\n\n")

		// Sort movie releases by Quality: 2160p -> 1080p -> 720p -> 480p
		releases := append([]resolver.StoredLink(nil), series.Episodes...)
		sort.Slice(releases, func(i, j int) bool {
			return qualityRank(releases[i].Quality) > qualityRank(releases[j].Quality)
		})

		itemNum := 0
		for _, m := range releases {
			dest := m.ProviderURL
			// Strict rule: never give mediator links, ONLY HubCloud
			if !strings.Contains(dest, "hubcloud") {
				continue
			}
			itemNum++
			sizeStr := m.SizeDisplay
			sizePart := ""
			if sizeStr != "" {
				sizePart = fmt.Sprintf("💾 %s | ", sizeStr)
			}
			name := m.Filename
			if name == "" {
				name = m.Title
			}
			sb.WriteString(fmt.Sprintf("<b>#%d: ⚡ %s</b>\n%s<a href=\"%s\">%s</a>\n⚡ HubCloud: %s\n\n",
				itemNum, strings.ToUpper(m.Quality), sizePart, dest, html.EscapeString(name), dest))
		}

		if statusMsg != nil {
			if _, err := b.teleBot.Edit(statusMsg, sb.String(), tele.ModeHTML); err == nil {
				return nil
			}
		}
		return c.Send(sb.String(), tele.ModeHTML)
	}

	// Case B: TV Series
	type qualityOpt struct {
		quality string
		size    string
		url     string
	}

	// 1. Group Season Packs by Season
	packMap := make(map[int][]qualityOpt)
	for _, p := range series.Packs {
		dest := p.ProviderURL
		// Strict rule: never give mediator links, ONLY HubCloud
		if !strings.Contains(dest, "hubcloud") {
			continue
		}
		s := p.Season
		if s == 0 {
			s = 1
		}
		q := p.Quality
		if q == "" {
			q = "HD"
		}
		packMap[s] = append(packMap[s], qualityOpt{
			quality: strings.ToUpper(q),
			size:    p.SizeDisplay,
			url:     dest,
		})
	}

	// Sort season numbers
	var seasons []int
	for s := range packMap {
		seasons = append(seasons, s)
	}
	sort.Ints(seasons)

	// --- MESSAGE 1: Series Overview & Season Complete Packs ---
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("🎬 <b>%s</b>\n", html.EscapeString(series.Title)))
	sb.WriteString(fmt.Sprintf("⚡ <i>Retrieved in %s</i>\n", formatDuration(duration)))
	sb.WriteString(fmt.Sprintf("📁 <b>Total Items:</b> %d (%d Season Packs + %d Episodes)\n\n",
		series.Total, len(series.Packs), len(series.Episodes)))

	if len(seasons) > 0 {
		sb.WriteString("📦 <b>SEASON COMPLETE PACKS:</b>\n\n")
		for _, s := range seasons {
			opts := packMap[s]
			sort.Slice(opts, func(i, j int) bool {
				return qualityRank(opts[i].quality) > qualityRank(opts[j].quality)
			})
			sb.WriteString(fmt.Sprintf("<b>• Season %d Complete:</b>\n", s))
			var linkParts []string
			for _, o := range opts {
				sizeLabel := ""
				if o.size != "" {
					sizeLabel = fmt.Sprintf(" (%s)", o.size)
				}
				linkParts = append(linkParts, fmt.Sprintf("⚡ <a href=\"%s\">%s%s</a>", o.url, o.quality, sizeLabel))
			}
			sb.WriteString(strings.Join(linkParts, " | "))
			sb.WriteString("\n\n")
		}
	}

	if statusMsg != nil {
		if _, err := b.teleBot.Edit(statusMsg, sb.String(), tele.ModeHTML); err != nil {
			_, _ = b.teleBot.Send(c.Recipient(), sb.String(), tele.ModeHTML)
		}
	} else {
		_, _ = b.teleBot.Send(c.Recipient(), sb.String(), tele.ModeHTML)
	}

	// --- MESSAGE 2: Group Episodes by (Season, Episode) -> Qualities ---
	if len(series.Episodes) > 0 {
		type epKey struct {
			Season  int
			Episode int
		}
		epMap := make(map[epKey][]qualityOpt)
		var epKeys []epKey

		for _, ep := range series.Episodes {
			dest := ep.ProviderURL
			// Strict rule: never give mediator links, ONLY HubCloud
			if !strings.Contains(dest, "hubcloud") {
				continue
			}
			q := ep.Quality
			if q == "" {
				q = "HD"
			}
			k := epKey{Season: ep.Season, Episode: ep.Episode}
			if len(epMap[k]) == 0 {
				epKeys = append(epKeys, k)
			}
			epMap[k] = append(epMap[k], qualityOpt{
				quality: strings.ToUpper(q),
				size:    ep.SizeDisplay,
				url:     dest,
			})
		}

		sort.Slice(epKeys, func(i, j int) bool {
			if epKeys[i].Season != epKeys[j].Season {
				return epKeys[i].Season < epKeys[j].Season
			}
			return epKeys[i].Episode < epKeys[j].Episode
		})

		var epLines []string
		currentSeason := -1
		for _, k := range epKeys {
			if k.Season != currentSeason {
				currentSeason = k.Season
				epLines = append(epLines, fmt.Sprintf("📺 <b>════════ SEASON %d EPISODES ════════</b>", currentSeason))
			}
			opts := epMap[k]
			sort.Slice(opts, func(i, j int) bool {
				return qualityRank(opts[i].quality) > qualityRank(opts[j].quality)
			})
			var qParts []string
			for _, o := range opts {
				sizeLabel := ""
				if o.size != "" {
					sizeLabel = fmt.Sprintf(" (%s)", o.size)
				}
				qParts = append(qParts, fmt.Sprintf("⚡ <a href=\"%s\">%s%s</a>", o.url, o.quality, sizeLabel))
			}
			epLines = append(epLines, fmt.Sprintf("<b>S%02dE%02d:</b> %s",
				k.Season, k.Episode, strings.Join(qParts, " | ")))
		}

		header := fmt.Sprintf("📺 <b>%s — EPISODES (BY QUALITY)</b>", html.EscapeString(series.Title))
		_ = b.sendChunkedMessages(c.Recipient(), header, epLines)
	}

	return nil
}

func qualityRank(q string) int {
	upper := strings.ToUpper(q)
	if strings.Contains(upper, "2160") || strings.Contains(upper, "4K") {
		return 400
	}
	if strings.Contains(upper, "1080") {
		return 300
	}
	if strings.Contains(upper, "720") {
		return 200
	}
	if strings.Contains(upper, "480") {
		return 100
	}
	return 50
}

func (b *Bot) sendChunkedMessages(recipient tele.Recipient, header string, lines []string) error {
	var sb strings.Builder
	sb.WriteString(header)
	sb.WriteString("\n")

	for _, line := range lines {
		if sb.Len()+len(line)+2 > 3000 {
			_, err := b.teleBot.Send(recipient, sb.String(), tele.ModeHTML)
			if err != nil {
				_, _ = b.teleBot.Send(recipient, sb.String())
			}
			sb.Reset()
			sb.WriteString(header)
			sb.WriteString(" (Continued)\n\n")
		}
		sb.WriteString(line)
		sb.WriteString("\n\n")
	}

	if sb.Len() > 0 {
		_, err := b.teleBot.Send(recipient, sb.String(), tele.ModeHTML)
		if err != nil {
			_, _ = b.teleBot.Send(recipient, sb.String())
		}
	}
	return nil
}

func (b *Bot) handleDownloadLinks(c tele.Context, matches []string) error {
	totalLinks := len(matches)
	statusMsg, _ := b.teleBot.Send(c.Recipient(), fmt.Sprintf("⚡ <i>Checking 3-tier cache for %d links...</i>", totalLinks), tele.ModeHTML)

	msgID := int64(0)
	if statusMsg != nil {
		msgID = int64(statusMsg.ID)
	}

	// 1. Try enqueuing to Render Rust Worker if available
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	enqueueResp, err := b.resolver.EnqueueBatchJob(ctx, matches, c.Chat().ID, msgID)
	if err == nil && enqueueResp != nil {
		// Case A: Instant cache hit for all links
		if enqueueResp.AllCached && len(enqueueResp.Results) > 0 {
			var sb strings.Builder
			sb.WriteString(fmt.Sprintf("🎯 <b>Instant Cache Hit: %d Link(s)</b>\n\n", len(enqueueResp.Results)))
			for i, res := range enqueueResp.Results {
				dest := res.Destination
				if strings.Contains(dest, "hubcloud") {
					sb.WriteString(fmt.Sprintf("<b>#%d:</b> ⚡ <a href=\"%s\"><b>Direct HubCloud Link</b></a>\n<code>%s</code>\n\n", i+1, dest, dest))
				}
			}
			if statusMsg != nil {
				_, _ = b.teleBot.Edit(statusMsg, sb.String(), tele.ModeHTML)
				return nil
			}
			return c.Send(sb.String(), tele.ModeHTML)
		}

		// Case B: Job successfully enqueued to cloud worker
		if enqueueResp.Queued {
			queuedText := fmt.Sprintf(
				"⚡ <b>Job #%s Queued</b>\n\nResolving %d link(s) on Cloud Worker...\nProgress will update live as links finish.",
				enqueueResp.JobID,
				totalLinks,
			)
			if statusMsg != nil {
				_, _ = b.teleBot.Edit(statusMsg, queuedText, tele.ModeHTML)
			}
			return nil
		}
	}

	// 2. Asynchronous Resolution with Live Telegram Progress Updates:
	// Runs in a background goroutine so Render's 60s request timeout is NEVER hit
	// and Telegram gets live progress updates throttled every 2.5-3.0 seconds!
	go b.processBatchAsync(c, statusMsg, matches)

	return nil
}

func (b *Bot) processBatchAsync(c tele.Context, statusMsg *tele.Message, urls []string) {
	total := len(urls)
	results := make([]resolver.Result, total)
	var completedCount int32
	var cacheHits int32
	var wg sync.WaitGroup

	workerSlots := cap(b.resolveSlot)
	if workerSlots <= 0 {
		workerSlots = 1
	}

	// Throttled Telegram Progress Updater (every 2.5 - 3 seconds to respect rate limits)
	doneChan := make(chan struct{})
	go func() {
		ticker := time.NewTicker(2500 * time.Millisecond)
		defer ticker.Stop()
		var lastReported int32 = -1

		for {
			select {
			case <-doneChan:
				return
			case <-ticker.C:
				current := atomic.LoadInt32(&completedCount)
				hits := atomic.LoadInt32(&cacheHits)
				if current > 0 && current != lastReported && current < int32(total) {
					lastReported = current
					progressText := fmt.Sprintf(
						"⏳ <b>Resolving Links...</b>\n\nProgress: <b>[%d/%d completed]</b> (%.0f%%)\n⚡ Instant Cache Hits: <b>%d</b>\n⚙️ Active Workers: <b>%d parallel max</b>",
						current, total, float64(current)/float64(total)*100, hits, workerSlots,
					)
					if statusMsg != nil {
						_, _ = b.teleBot.Edit(statusMsg, progressText, tele.ModeHTML)
					}
				}
			}
		}
	}()

	start := time.Now()

	for i, targetURL := range urls {
		wg.Add(1)
		go func(idx int, rawURL string) {
			defer wg.Done()
			defer atomic.AddInt32(&completedCount, 1)

			itemStart := time.Now()

			// 1. Check 3-Tier Cache (L1 sync.Map -> L2 Redis -> L3 MongoDB) BEFORE semaphore
			if cachedDest, hit, err := b.cache.Get(context.Background(), rawURL); hit {
				atomic.AddInt32(&cacheHits, 1)
				if errors.Is(err, cache.ErrDeadLink) {
					results[idx] = resolver.Result{
						SourceURL: rawURL,
						Duration:  time.Since(itemStart),
						Err:       cache.ErrDeadLink,
						IsDead:    true,
						FromCache: true,
					}
					return
				}
				results[idx] = resolver.Result{
					SourceURL:   rawURL,
					Destination: cachedDest,
					FromCache:   true,
					Duration:    time.Since(itemStart),
					Err:         nil,
				}
				return
			}

			// 2. Acquire bounded worker slot
			b.resolveSlot <- struct{}{}
			defer func() { <-b.resolveSlot }()

			// Start the resolver deadline after acquiring a slot so queue wait does
			// not consume the time available for the actual resolution.
			resolveTimeout := b.resolver.Timeout()
			if resolveTimeout <= 0 {
				resolveTimeout = 90 * time.Second
			}
			ctx, cancel := context.WithTimeout(context.Background(), resolveTimeout)
			defer cancel()

			// 3. Re-check cache in case duplicate finished while waiting
			if cachedDest, hit, err := b.cache.Get(ctx, rawURL); hit {
				atomic.AddInt32(&cacheHits, 1)
				if errors.Is(err, cache.ErrDeadLink) {
					results[idx] = resolver.Result{
						SourceURL: rawURL,
						Duration:  time.Since(itemStart),
						Err:       cache.ErrDeadLink,
						IsDead:    true,
						FromCache: true,
					}
					return
				}
				results[idx] = resolver.Result{
					SourceURL:   rawURL,
					Destination: cachedDest,
					FromCache:   true,
					Duration:    time.Since(itemStart),
					Err:         nil,
				}
				return
			}

			// 4. Resolve via Engine (with fail-fast dead check)
			res := b.resolver.ResolveAfterCacheMiss(ctx, rawURL)
			results[idx] = res
		}(i, targetURL)
	}

	wg.Wait()
	close(doneChan)
	totalDuration := time.Since(start)

	// Format final response
	header := fmt.Sprintf("🎯 <b>Batch Finished: %d Link(s) in %s</b>\n⚡ <i>%d retrieved instantly from cache</i>\n\n", total, formatDuration(totalDuration), atomic.LoadInt32(&cacheHits))

	var resultLines []string
	var fullSB strings.Builder
	fullSB.WriteString(header)

	for i, res := range results {
		var itemSB strings.Builder
		if errors.Is(res.Err, cache.ErrDeadLink) || res.IsDead {
			itemSB.WriteString(fmt.Sprintf("<b>#%d:</b> ❌ <b>Dead / Expired Link (404)</b>\n<i>Source returned invalid token or HubCloud ID not found</i>\n\n", i+1))
		} else if res.Err != nil {
			itemSB.WriteString(fmt.Sprintf("<b>#%d:</b> ⚠️ <b>Resolution Failed</b>: %s\n\n", i+1, html.EscapeString(res.Err.Error())))
		} else {
			tag := "⚡"
			if !res.FromCache {
				tag = "🔄"
			}
			dest := res.Destination
			// Strict Rule: Never output mediator link, ONLY HubCloud!
			if strings.Contains(dest, "hubcloud") {
				itemSB.WriteString(fmt.Sprintf("<b>#%d:</b> %s <a href=\"%s\"><b>Direct HubCloud Link</b></a>\n<code>%s</code>\n⚡ Speed: %s\n\n", i+1, tag, dest, dest, formatDuration(res.Duration)))
			} else {
				itemSB.WriteString(fmt.Sprintf("<b>#%d:</b> ⚠️ <i>Skipped non-HubCloud link</i>\n\n", i+1))
			}
		}
		itemStr := itemSB.String()
		resultLines = append(resultLines, itemStr)
		fullSB.WriteString(itemStr)
	}

	if fullSB.Len() < 3500 && statusMsg != nil {
		_, err := b.teleBot.Edit(statusMsg, fullSB.String(), tele.ModeHTML)
		if err == nil {
			return
		}
	}

	if statusMsg != nil {
		statusDone := fmt.Sprintf("%s<i>Delivering all %d resolved links below:</i>", header, total)
		_, _ = b.teleBot.Edit(statusMsg, statusDone, tele.ModeHTML)
	}

	_ = b.sendChunkedMessages(c.Recipient(), header, resultLines)
}

func calculateHitRatio(hits, misses uint64) float64 {
	total := hits + misses
	if total == 0 {
		return 0.0
	}
	return (float64(hits) / float64(total)) * 100
}

func formatDuration(d time.Duration) string {
	if d < time.Millisecond {
		return fmt.Sprintf("%.2f µs", float64(d.Microseconds()))
	}
	if d < time.Second {
		return fmt.Sprintf("%.2f ms", float64(d.Milliseconds()))
	}
	return fmt.Sprintf("%.2f s", d.Seconds())
}

func truncateURL(u string, maxLen int) string {
	if len(u) <= maxLen {
		return u
	}
	return u[:maxLen-3] + "..."
}
