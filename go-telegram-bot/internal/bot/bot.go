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
	msg := `⚡ <b>High-Speed Link & Media Bot (4KHub4U + XDMovies)</b>

Powered by Go Goroutines, Channels, and In-Memory Caching:
• <b>4KHub4U & XDMovies:</b> Send any movie/series URL to get <b>ALL</b> releases with full titles & direct HubCloud links!
• <b>Auto-Scrape:</b> Automatically scrapes new titles on-demand if not yet cached!
• <b>Parallel Shortener Resolver:</b> Resolves mediator links (GreenMotors / XDMovies) concurrently into direct HubCloud links.
• <b>Microsecond Cache:</b> Stored links return in &lt;1ms.

👉 <b>Try sending:</b>
1. Any Movie or Series title: <code>Campus Drivers</code>, <code>Mirzapur</code>, or <code>Avatar</code>
2. A 4KHDHub / 4KHub4U link:
<code>https://4khdhub.one/dexter-resurrection-series-2297/</code>
3. An XDMovies link:
<code>https://huh.xdmovies.wtf/series/campus-drivers-2160p-1080p-hindi-french-download-303044</code>`
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
		return c.Send("ℹ️ <b>Manual Cache Ingestion:</b>\n\nWhen a link presents a challenge, open it in your browser to get the final HubCloud URL, then send:\n<code>/cache &lt;mediator_url&gt; &lt;hubcloud_url&gt;</code>\n\nExample:\n<code>/cache https://4khdhub.one/download-link https://hubcloud.pw/drive/abc</code>", tele.ModeHTML)
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
		errMsg := fmt.Sprintf("❌ <b>Could not retrieve releases for:</b>\n<code>%s</code>\n\n<i>Reason: %s</i>\n\n👉 <i>Try sending another 4KHub4U link or movie/series title!</i>",
			html.EscapeString(contentURL), html.EscapeString(err.Error()))
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
		sb.WriteString(fmt.Sprintf("📁 <b>Available Releases:</b> %d\n", series.Total))
		sb.WriteString("━━━━━━━━━━━━━━━━━━━━━━\n\n")

		type movieGroup struct {
			Category string
			Rank     int
			Links    []resolver.StoredLink
		}
		groupsMap := make(map[string]*movieGroup)
		var groupKeys []string

		for _, m := range series.Episodes {
			dest := m.ProviderURL
			if dest == "" {
				dest = m.MediatorURL
			}
			if dest == "" || strings.Contains(strings.ToLower(dest), "hubdrive") || strings.EqualFold(m.Provider, "HubDrive") {
				continue
			}
			cat, rank := getReleaseCategory(m.Filename, m.Quality)
			if groupsMap[cat] == nil {
				groupsMap[cat] = &movieGroup{Category: cat, Rank: rank}
				groupKeys = append(groupKeys, cat)
			}
			groupsMap[cat].Links = append(groupsMap[cat].Links, m)
		}

		sort.Slice(groupKeys, func(i, j int) bool {
			return groupsMap[groupKeys[i]].Rank > groupsMap[groupKeys[j]].Rank
		})

		for _, cat := range groupKeys {
			grp := groupsMap[cat]
			sb.WriteString(fmt.Sprintf("🎬 <b>%s:</b>\n", grp.Category))
			for _, m := range grp.Links {
				name := m.Filename
				if name == "" {
					name = m.Title
				}
				dest := m.ProviderURL
				if dest == "" {
					dest = m.MediatorURL
				}
				sizeStr := m.SizeDisplay
				sizeLine := ""
				if sizeStr != "" {
					sizeLine = fmt.Sprintf("   ├ 💾 <b>Size:</b> %s\n", sizeStr)
				}
				sb.WriteString(fmt.Sprintf("📄 <code>%s</code>\n%s   └ ⚡ <b>HubCloud:</b> <a href=\"%s\">%s</a>\n\n",
					html.EscapeString(name), sizeLine, dest, dest))
			}
		}

		if statusMsg != nil {
			if _, err := b.teleBot.Edit(statusMsg, sb.String(), tele.ModeHTML); err == nil {
				return nil
			}
		}
		return c.Send(sb.String(), tele.ModeHTML)
	}

	// Case B: TV Series
	type qualitySection struct {
		Category string
		Rank     int
		Packs    []resolver.StoredLink
		Episodes []resolver.StoredLink
	}

	type seasonGroup struct {
		Season      int
		Qualities   map[string]*qualitySection
		QualityKeys []string
	}

	seasonsMap := make(map[int]*seasonGroup)
	var seasonsList []int

	getOrCreateSeason := func(s int) *seasonGroup {
		if s <= 0 {
			s = 1
		}
		if seasonsMap[s] == nil {
			seasonsMap[s] = &seasonGroup{
				Season:    s,
				Qualities: make(map[string]*qualitySection),
			}
			seasonsList = append(seasonsList, s)
		}
		return seasonsMap[s]
	}

	getOrCreateQuality := func(sg *seasonGroup, filename, quality string) *qualitySection {
		cat, rank := getReleaseCategory(filename, quality)
		if sg.Qualities[cat] == nil {
			sg.Qualities[cat] = &qualitySection{
				Category: cat,
				Rank:     rank,
			}
			sg.QualityKeys = append(sg.QualityKeys, cat)
		}
		return sg.Qualities[cat]
	}

	// 1. Add all Season Packs
	for _, p := range series.Packs {
		dest := p.ProviderURL
		if dest == "" {
			dest = p.MediatorURL
		}
		if dest == "" || strings.Contains(strings.ToLower(dest), "hubdrive") || strings.EqualFold(p.Provider, "HubDrive") {
			continue
		}
		sg := getOrCreateSeason(p.Season)
		qs := getOrCreateQuality(sg, p.Filename, p.Quality)
		qs.Packs = append(qs.Packs, p)
	}

	// 2. Add all Episodes
	for _, ep := range series.Episodes {
		dest := ep.ProviderURL
		if dest == "" {
			dest = ep.MediatorURL
		}
		if dest == "" || strings.Contains(strings.ToLower(dest), "hubdrive") || strings.EqualFold(ep.Provider, "HubDrive") {
			continue
		}
		sg := getOrCreateSeason(ep.Season)
		qs := getOrCreateQuality(sg, ep.Filename, ep.Quality)
		qs.Episodes = append(qs.Episodes, ep)
	}

	sort.Ints(seasonsList)

	// Format Header / Overview
	var sbOverview strings.Builder
	sbOverview.WriteString(fmt.Sprintf("🔥 <b>%s</b>\n", html.EscapeString(series.Title)))
	sbOverview.WriteString(fmt.Sprintf("⚡ <i>Retrieved in %s</i>\n", formatDuration(duration)))
	sbOverview.WriteString(fmt.Sprintf("📁 <b>Total Items:</b> %d (%d Season Packs + %d Episodes)\n",
		series.Total, len(series.Packs), len(series.Episodes)))
	sbOverview.WriteString("━━━━━━━━━━━━━━━━━━━━━━\n\n")

	// Build blocks per Season -> Quality -> Zip -> Episodes
	var msgBlocks []string
	for _, s := range seasonsList {
		sg := seasonsMap[s]
		sort.Slice(sg.QualityKeys, func(i, j int) bool {
			return sg.Qualities[sg.QualityKeys[i]].Rank > sg.Qualities[sg.QualityKeys[j]].Rank
		})

		for _, qKey := range sg.QualityKeys {
			qs := sg.Qualities[qKey]
			var qSB strings.Builder
			qSB.WriteString(fmt.Sprintf("📺 <b>════ SEASON %d • %s ════</b>\n\n", s, qs.Category))

			// Zip / Pack first!
			if len(qs.Packs) > 0 {
				qSB.WriteString("📦 <b>Complete Season Pack:</b>\n")
				for _, p := range qs.Packs {
					name := p.Filename
					if name == "" {
						name = p.Title
					}
					dest := p.ProviderURL
					if dest == "" {
						dest = p.MediatorURL
					}
					sizeStr := p.SizeDisplay
					sizeLine := ""
					if sizeStr != "" {
						sizeLine = fmt.Sprintf("   ├ 💾 <b>Size:</b> %s\n", sizeStr)
					}
					qSB.WriteString(fmt.Sprintf("📁 <code>%s</code>\n%s   └ ⚡ <b>HubCloud:</b> <a href=\"%s\">%s</a>\n\n",
						html.EscapeString(name), sizeLine, dest, dest))
				}
			}

			// Individual episodes for this quality right below the zip!
			if len(qs.Episodes) > 0 {
				sort.Slice(qs.Episodes, func(i, j int) bool {
					return qs.Episodes[i].Episode < qs.Episodes[j].Episode
				})
				qSB.WriteString("🎞️ <b>Episodes:</b>\n")
				for _, ep := range qs.Episodes {
					name := ep.Filename
					if name == "" {
						name = ep.Title
					}
					dest := ep.ProviderURL
					if dest == "" {
						dest = ep.MediatorURL
					}
					sizeStr := ep.SizeDisplay
					sizeLine := ""
					if sizeStr != "" {
						sizeLine = fmt.Sprintf("   ├ 💾 <b>Size:</b> %s\n", sizeStr)
					}
					qSB.WriteString(fmt.Sprintf("📄 <code>%s</code>\n%s   └ ⚡ <b>HubCloud:</b> <a href=\"%s\">%s</a>\n\n",
						html.EscapeString(name), sizeLine, dest, dest))
				}
			}

			msgBlocks = append(msgBlocks, qSB.String())
		}
	}

	// Send / Edit Overview
	if statusMsg != nil {
		if _, err := b.teleBot.Edit(statusMsg, sbOverview.String(), tele.ModeHTML); err != nil {
			_, _ = b.teleBot.Send(c.Recipient(), sbOverview.String(), tele.ModeHTML)
		}
	} else {
		_, _ = b.teleBot.Send(c.Recipient(), sbOverview.String(), tele.ModeHTML)
	}

	// Dispatch chunked messages (< 3200 chars per message)
	if len(msgBlocks) > 0 {
		var currentMsg strings.Builder
		for _, block := range msgBlocks {
			if currentMsg.Len()+len(block) > 3200 && currentMsg.Len() > 0 {
				_, _ = b.teleBot.Send(c.Recipient(), currentMsg.String(), tele.ModeHTML)
				currentMsg.Reset()
			}
			currentMsg.WriteString(block)
		}
		if currentMsg.Len() > 0 {
			_, _ = b.teleBot.Send(c.Recipient(), currentMsg.String(), tele.ModeHTML)
		}
	}

	return nil
}

func getReleaseCategory(filename, quality string) (string, int) {
	lower := strings.ToLower(filename)
	qLower := strings.ToLower(quality)

	is2160 := strings.Contains(lower, "2160p") || strings.Contains(lower, "4k") || strings.Contains(qLower, "2160") || strings.Contains(qLower, "4k")
	is1080 := strings.Contains(lower, "1080p") || strings.Contains(qLower, "1080")
	is720 := strings.Contains(lower, "720p") || strings.Contains(qLower, "720")
	is480 := strings.Contains(lower, "480p") || strings.Contains(qLower, "480")

	isH265 := strings.Contains(lower, "h.265") || strings.Contains(lower, "h265") || strings.Contains(lower, "hevc") || strings.Contains(lower, "x265")
	isH264 := strings.Contains(lower, "h.264") || strings.Contains(lower, "h264") || strings.Contains(lower, "avc") || strings.Contains(lower, "x264")

	if is2160 {
		if strings.Contains(lower, "sdr") {
			return "2160p SDR", 500
		}
		if strings.Contains(lower, "hdr") {
			return "2160p HDR", 510
		}
		return "2160p (4K UHD)", 520
	}
	if is1080 {
		if isH265 {
			return "1080p H.265 (HEVC)", 420
		}
		if isH264 {
			return "1080p H.264 (AVC)", 410
		}
		return "1080p Full HD", 400
	}
	if is720 {
		if isH265 {
			return "720p H.265 (HEVC)", 320
		}
		if isH264 {
			return "720p H.264 (AVC)", 310
		}
		return "720p HD", 300
	}
	if is480 {
		return "480p SD", 200
	}
	if quality != "" {
		return strings.ToUpper(quality), 100
	}
	return "Standard Releases", 50
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
	if len(lines) == 0 {
		return nil
	}
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

	// 1. Try enqueuing to Render Rust Worker if available (skip immediately if not configured)
	if b.resolver.HasRustWorker() {
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

			// 3. Re-check in-memory L1 cache in case duplicate finished while waiting (avoids duplicate remote L2/L3 work)
			if cachedDest, hit, err := b.cache.GetL1(rawURL); hit {
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

	// Format categorized batch response
	header := fmt.Sprintf("🎯 <b>Batch Finished: %d Link(s) in %s</b>\n⚡ <i>%d retrieved instantly from cache</i>\n━━━━━━━━━━━━━━━━━━━━━━\n\n",
		total, formatDuration(totalDuration), atomic.LoadInt32(&cacheHits))

	type resolvedMetaItem struct {
		Result  resolver.Result
		Item    resolver.StoredLink
		HasMeta bool
	}

	type batchQualitySection struct {
		Category string
		Rank     int
		Packs    []resolvedMetaItem
		Episodes []resolvedMetaItem
	}
	type batchSeasonGroup struct {
		Season      int
		Qualities   map[string]*batchQualitySection
		QualityKeys []string
	}
	bSeasonsMap := make(map[int]*batchSeasonGroup)
	var bSeasonsList []int
	var others []resolvedMetaItem

	getOrCreateBatchSeason := func(s int) *batchSeasonGroup {
		if s <= 0 {
			s = 1
		}
		if bSeasonsMap[s] == nil {
			bSeasonsMap[s] = &batchSeasonGroup{
				Season:    s,
				Qualities: make(map[string]*batchQualitySection),
			}
			bSeasonsList = append(bSeasonsList, s)
		}
		return bSeasonsMap[s]
	}

	getOrCreateBatchQuality := func(bsg *batchSeasonGroup, filename, quality string) *batchQualitySection {
		cat, rank := getReleaseCategory(filename, quality)
		if bsg.Qualities[cat] == nil {
			bsg.Qualities[cat] = &batchQualitySection{
				Category: cat,
				Rank:     rank,
			}
			bsg.QualityKeys = append(bsg.QualityKeys, cat)
		}
		return bsg.Qualities[cat]
	}

	for _, res := range results {
		it := resolvedMetaItem{Result: res}
		if res.Err == nil && strings.Contains(res.Destination, "hubcloud") {
			if stored, ok := b.resolver.LookupStoredLink(context.Background(), res.SourceURL, res.Destination); ok {
				it.Item = stored
				it.HasMeta = true
			}
		}

		if !it.HasMeta || it.Result.Err != nil || !strings.Contains(it.Result.Destination, "hubcloud") {
			others = append(others, it)
		} else {
			isPack := it.Item.Scope == "pack" || it.Item.Type == "pack" || strings.HasSuffix(strings.ToLower(it.Item.Filename), ".zip")
			bsg := getOrCreateBatchSeason(it.Item.Season)
			bqs := getOrCreateBatchQuality(bsg, it.Item.Filename, it.Item.Quality)
			if isPack {
				bqs.Packs = append(bqs.Packs, it)
			} else {
				bqs.Episodes = append(bqs.Episodes, it)
			}
		}
	}

	var msgBlocks []string
	sort.Ints(bSeasonsList)

	for _, s := range bSeasonsList {
		bsg := bSeasonsMap[s]
		sort.Slice(bsg.QualityKeys, func(i, j int) bool {
			return bsg.Qualities[bsg.QualityKeys[i]].Rank > bsg.Qualities[bsg.QualityKeys[j]].Rank
		})

		for _, qKey := range bsg.QualityKeys {
			bqs := bsg.Qualities[qKey]
			var qSB strings.Builder
			qSB.WriteString(fmt.Sprintf("📺 <b>════ SEASON %d • %s ════</b>\n\n", s, bqs.Category))

			// Zip / Pack first!
			if len(bqs.Packs) > 0 {
				qSB.WriteString("📦 <b>Complete Season Pack:</b>\n")
				for _, p := range bqs.Packs {
					name := p.Item.Filename
					if name == "" {
						name = p.Item.Title
					}
					dest := p.Result.Destination
					sizeStr := p.Item.SizeDisplay
					sizeLine := ""
					if sizeStr != "" {
						sizeLine = fmt.Sprintf("   ├ 💾 <b>Size:</b> %s\n", sizeStr)
					}
					qSB.WriteString(fmt.Sprintf("📁 <code>%s</code>\n%s   └ ⚡ <b>HubCloud:</b> <a href=\"%s\">%s</a>\n\n",
						html.EscapeString(name), sizeLine, dest, dest))
				}
			}

			// Episodes for this quality right below the zip!
			if len(bqs.Episodes) > 0 {
				sort.Slice(bqs.Episodes, func(i, j int) bool {
					return bqs.Episodes[i].Item.Episode < bqs.Episodes[j].Item.Episode
				})
				qSB.WriteString("🎞️ <b>Episodes:</b>\n")
				for _, ep := range bqs.Episodes {
					name := ep.Item.Filename
					if name == "" {
						name = ep.Item.Title
					}
					dest := ep.Result.Destination
					sizeStr := ep.Item.SizeDisplay
					sizeLine := ""
					if sizeStr != "" {
						sizeLine = fmt.Sprintf("   ├ 💾 <b>Size:</b> %s\n", sizeStr)
					}
					qSB.WriteString(fmt.Sprintf("📄 <code>%s</code>\n%s   └ ⚡ <b>HubCloud:</b> <a href=\"%s\">%s</a>\n\n",
						html.EscapeString(name), sizeLine, dest, dest))
				}
			}

			msgBlocks = append(msgBlocks, qSB.String())
		}
	}

	// Section 3: Others / Uncategorized / Failures
	if len(others) > 0 {
		var oSB strings.Builder
		if len(bSeasonsList) > 0 {
			oSB.WriteString("🔗 <b>Other Resolved Links:</b>\n")
		}
		for i, it := range others {
			res := it.Result
			if errors.Is(res.Err, cache.ErrDeadLink) || res.IsDead {
				oSB.WriteString(fmt.Sprintf("<b>#%d:</b> ❌ <b>Dead / Expired Link (404)</b>\n<i>Source returned invalid token or HubCloud ID not found</i>\n\n", i+1))
			} else if res.Err != nil {
				oSB.WriteString(fmt.Sprintf("<b>#%d:</b> ⚠️ <b>Resolution Failed</b>: %s\n\n", i+1, html.EscapeString(res.Err.Error())))
			} else {
				dest := res.Destination
				tag := "⚡"
				if !res.FromCache {
					tag = "🔄"
				}
				if strings.Contains(dest, "hubcloud") {
					titleLine := ""
					if res.Title != "" {
						titleLine = fmt.Sprintf("📄 <code>%s</code>\n", html.EscapeString(res.Title))
					}
					oSB.WriteString(fmt.Sprintf("<b>#%d:</b> %s <a href=\"%s\"><b>Direct HubCloud Link</b></a>\n%s<code>%s</code>\n⚡ Speed: %s\n\n",
						i+1, tag, dest, titleLine, dest, formatDuration(res.Duration)))
				} else {
					oSB.WriteString(fmt.Sprintf("<b>#%d:</b> ⚠️ <i>Skipped non-HubCloud link</i>\n\n", i+1))
				}
			}
		}
		msgBlocks = append(msgBlocks, oSB.String())
	}

	var fullSB strings.Builder
	fullSB.WriteString(header)
	for _, block := range msgBlocks {
		fullSB.WriteString(block)
	}

	if fullSB.Len() < 3500 && statusMsg != nil {
		_, err := b.teleBot.Edit(statusMsg, fullSB.String(), tele.ModeHTML)
		if err == nil {
			return
		}
	}

	if statusMsg != nil {
		statusDone := fmt.Sprintf("%s<i>Delivering all %d categorized links below:</i>", header, total)
		_, _ = b.teleBot.Edit(statusMsg, statusDone, tele.ModeHTML)
	}

	var currentMsg strings.Builder
	for _, block := range msgBlocks {
		if currentMsg.Len()+len(block) > 3200 && currentMsg.Len() > 0 {
			_, _ = b.teleBot.Send(c.Recipient(), currentMsg.String(), tele.ModeHTML)
			currentMsg.Reset()
		}
		currentMsg.WriteString(block)
	}
	if currentMsg.Len() > 0 {
		_, _ = b.teleBot.Send(c.Recipient(), currentMsg.String(), tele.ModeHTML)
	}
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
