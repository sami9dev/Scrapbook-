package bot

import (
	"context"
	"fmt"
	"html"
	"log"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	tele "gopkg.in/telebot.v3"

	"go-telegram-bot/internal/cache"
	"go-telegram-bot/internal/pool"
	"go-telegram-bot/internal/resolver"
)

var urlRegex = regexp.MustCompile(`https?://[^\s/$.?#].[^\s]*`)

type Bot struct {
	teleBot   *tele.Bot
	pool      *pool.WorkerPool
	resolver  *resolver.Resolver
	cache     *cache.MemoryCache
	startTime time.Time
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
		teleBot:   b,
		pool:      p,
		resolver:  r,
		cache:     c,
		startTime: time.Now(),
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
	text := c.Text()
	matches := urlRegex.FindAllString(text, -1)

	if len(matches) == 0 {
		return c.Send("ℹ️ Please send a valid link or multiple links to resolve.")
	}

	// 1. Check if the URL is a Series or Movie content page
	firstURL := matches[0]
	if b.resolver.IsContentPage(firstURL) {
		return b.handleContentPage(c, firstURL)
	}

	// 2. Otherwise handle as download mediator links
	return b.handleDownloadLinks(c, matches)
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

	// Case A: Movie
	if series.IsMovie {
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("🎬 <b>%s</b>\n", html.EscapeString(series.Title)))
		sb.WriteString(fmt.Sprintf("⚡ <i>Retrieved in %s</i>\n", formatDuration(duration)))
		sb.WriteString(fmt.Sprintf("📁 <b>Total Available Releases:</b> %d\n\n", series.Total))
		sb.WriteString("🎬 <b>MOVIE DOWNLOADS:</b>\n\n")

		for idx, m := range series.Episodes {
			dest := m.ProviderURL
			if dest == "" {
				dest = m.MediatorURL
			}
			sizeStr := m.SizeDisplay
			sizePart := ""
			if sizeStr != "" {
				sizePart = fmt.Sprintf("💾 %s | ", sizeStr)
			}
			name := m.Filename
			if name == "" {
				name = m.Title
			}
			destLabel := "Destination:"
			if strings.Contains(dest, "hubcloud") {
				destLabel = "HubCloud:"
			} else {
				destLabel = "Mediator Link (Resolving in background):"
			}
			sb.WriteString(fmt.Sprintf("<b>#%d:</b> <a href=\"%s\">%s</a>\n%s⚡ %s\n%s %s\n\n",
				idx+1, dest, html.EscapeString(name), sizePart, strings.ToUpper(m.Quality), destLabel, dest))
		}

		if statusMsg != nil {
			_, err = b.teleBot.Edit(statusMsg, sb.String(), tele.ModeHTML)
			if err == nil {
				return nil
			}
		}
		return c.Send(sb.String(), tele.ModeHTML)
	}

	// Case B: Series
	sort.Slice(series.Packs, func(i, j int) bool {
		if series.Packs[i].Season != series.Packs[j].Season {
			return series.Packs[i].Season < series.Packs[j].Season
		}
		return series.Packs[i].Quality > series.Packs[j].Quality
	})

	sort.Slice(series.Episodes, func(i, j int) bool {
		if series.Episodes[i].Season != series.Episodes[j].Season {
			return series.Episodes[i].Season < series.Episodes[j].Season
		}
		if series.Episodes[i].Episode != series.Episodes[j].Episode {
			return series.Episodes[i].Episode < series.Episodes[j].Episode
		}
		return series.Episodes[i].Quality > series.Episodes[j].Quality
	})

	// --- MESSAGE 1: Series Overview & All Season Packs ---
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("🎬 <b>%s</b>\n", html.EscapeString(series.Title)))
	sb.WriteString(fmt.Sprintf("⚡ <i>Retrieved in %s</i>\n", formatDuration(duration)))
	sb.WriteString(fmt.Sprintf("📁 <b>Total Items:</b> %d (%d Season Packs + %d Episodes)\n\n",
		series.Total, len(series.Packs), len(series.Episodes)))

	if len(series.Packs) > 0 {
		sb.WriteString("📦 <b>SEASON PACKS:</b>\n\n")
		for idx, p := range series.Packs {
			dest := p.ProviderURL
			if dest == "" {
				dest = p.MediatorURL
			}
			sizeStr := p.SizeDisplay
			if sizeStr == "" {
				sizeStr = "Full Pack"
			}
			name := p.Filename
			if name == "" {
				name = p.Title
			}
			destLabel := "Destination:"
			if strings.Contains(dest, "hubcloud") {
				destLabel = "HubCloud:"
			} else {
				destLabel = "Mediator Link (Resolving in background):"
			}
			sb.WriteString(fmt.Sprintf("<b>#%d:</b> <a href=\"%s\">%s</a>\n💾 %s | ⚡ %s\n%s %s\n\n",
				idx+1, dest, html.EscapeString(name), sizeStr, strings.ToUpper(p.Quality), destLabel, dest))
		}
	}

	if statusMsg != nil {
		if _, err := b.teleBot.Edit(statusMsg, sb.String(), tele.ModeHTML); err != nil {
			log.Printf("[Bot] Failed to edit statusMsg: %v. Sending direct message...", err)
			_, _ = b.teleBot.Send(c.Recipient(), sb.String(), tele.ModeHTML)
		}
	} else {
		_, _ = b.teleBot.Send(c.Recipient(), sb.String(), tele.ModeHTML)
	}

	// --- MESSAGE 2+: All Episodes with Full Release Titles ---
	if len(series.Episodes) > 0 {
		var epLines []string
		currentSeason := -1
		epIdx := 0
		for _, ep := range series.Episodes {
			if ep.Season != currentSeason {
				currentSeason = ep.Season
				epIdx = 0
				epLines = append(epLines, fmt.Sprintf("📺 ════════ SEASON %d EPISODES ════════", currentSeason))
			}
			epIdx++
			dest := ep.ProviderURL
			if dest == "" {
				dest = ep.MediatorURL
			}
			sizeStr := ep.SizeDisplay
			sizePart := ""
			if sizeStr != "" {
				sizePart = fmt.Sprintf("💾 %s | ", sizeStr)
			}
			name := ep.Filename
			if name == "" {
				name = ep.Title
			}
			destLabel := "Destination:"
			if strings.Contains(dest, "hubcloud") {
				destLabel = "HubCloud:"
			} else {
				destLabel = "Mediator Link (Resolving in background):"
			}
			epLines = append(epLines, fmt.Sprintf("<b>#%d:</b> <a href=\"%s\">%s</a>\n%s⚡ %s\n%s %s",
				epIdx, dest, html.EscapeString(name), sizePart, strings.ToUpper(ep.Quality), destLabel, dest))
		}

		header := fmt.Sprintf("📺 <b>%s — ALL EPISODES</b>", html.EscapeString(series.Title))
		_ = b.sendChunkedMessages(c.Recipient(), header, epLines)
	}

	return nil
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
	statusMsg, _ := b.teleBot.Send(c.Recipient(), fmt.Sprintf("⚡ <i>Checking cloud queue for batch of %d links...</i>", totalLinks), tele.ModeHTML)

	msgID := int64(0)
	if statusMsg != nil {
		msgID = int64(statusMsg.ID)
	}

	// 1. Try enqueuing to Render Rust Worker
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	enqueueResp, err := b.resolver.EnqueueBatchJob(ctx, matches, c.Chat().ID, msgID)
	if err == nil && enqueueResp != nil {
		// Case A: Instant cache hit for all links
		if enqueueResp.AllCached && len(enqueueResp.Results) > 0 {
			var sb strings.Builder
			sb.WriteString(fmt.Sprintf("🎯 <b>Instant Cache Hit: %d Link(s)</b>\n\n", len(enqueueResp.Results)))
			for i, res := range enqueueResp.Results {
				label := "Destination:"
				if strings.Contains(res.Destination, "hubcloud") {
					label = "HubCloud:"
				}
				sb.WriteString(fmt.Sprintf("<b>#%d:</b> <a href=\"%s\">Resolved Link</a>\n%s %s\n\n", i+1, res.Destination, label, res.Destination))
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
				"⚡ <b>Job #%s Queued</b>\n\nResolving %d link(s) on Render Cloud Worker...\nProgress will update live as links finish.",
				enqueueResp.JobID,
				totalLinks,
			)
			if statusMsg != nil {
				_, _ = b.teleBot.Edit(statusMsg, queuedText, tele.ModeHTML)
			}
			// PROMPT RETURN: The Telegram request does NOT wait! Cloud worker updates the message.
			return nil
		}
	}

	// Fallback if cloud worker not connected: Safe local fallback without heavy browsers
	start := time.Now()
	results := b.pool.ResolveBatchWithProgress(matches, func(res resolver.Result, done, total int) {
		if statusMsg != nil {
			statusText := fmt.Sprintf("⚡ <i>Resolving: <b>[%d/%d completed]</b> (%.0f%%)...</i>\nLatest: <code>%s</code>",
				done, total, float64(done)/float64(total)*100, truncateURL(res.Destination, 40))
			_, _ = b.teleBot.Edit(statusMsg, statusText, tele.ModeHTML)
		}
	})
	totalDuration := time.Since(start)

	header := fmt.Sprintf("🎯 <b>Resolved %d Link(s) in %s</b>\n", totalLinks, formatDuration(totalDuration))

	var resultLines []string
	var fullSB strings.Builder
	fullSB.WriteString(header)
	fullSB.WriteString("\n")

	for i, res := range results {
		var itemSB strings.Builder
		titleText := res.Title
		if titleText == "" {
			titleText = truncateURL(res.SourceURL, 45)
		}
		itemSB.WriteString(fmt.Sprintf("<b>#%d:</b> <a href=\"%s\">%s</a>\n", i+1, res.Destination, html.EscapeString(titleText)))

		if res.Err != nil {
			itemSB.WriteString(fmt.Sprintf("Error: %s\n", res.Err.Error()))
		} else {
			destLabel := "Destination:"
			if strings.Contains(res.Destination, "hubcloud") {
				destLabel = "HubCloud:"
			}
			itemSB.WriteString(fmt.Sprintf("%s %s\n", destLabel, res.Destination))
			itemSB.WriteString(fmt.Sprintf("Speed: %s\n", formatDuration(res.Duration)))
		}
		itemStr := itemSB.String()
		resultLines = append(resultLines, itemStr)
		fullSB.WriteString(itemStr)
		fullSB.WriteString("\n")
	}

	if fullSB.Len() < 3500 && statusMsg != nil {
		_, err := b.teleBot.Edit(statusMsg, fullSB.String(), tele.ModeHTML)
		if err == nil {
			return nil
		}
	}

	if statusMsg != nil {
		statusDone := fmt.Sprintf("%s\n<i>Batch complete! Delivering all %d links below:</i>", header, totalLinks)
		_, _ = b.teleBot.Edit(statusMsg, statusDone, tele.ModeHTML)
	}

	return b.sendChunkedMessages(c.Recipient(), header, resultLines)
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
