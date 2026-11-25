package bot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"log"
	"regexp"
	"runtime"
	"sort"
	"strconv"
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
var seriesPattern = regexp.MustCompile(`(?i)\b(s\d{1,2}|season\s*\d{1,2}|ep\d{1,3}|episode\s*\d{1,3})\b`)

func isSeriesRelease(scope, filename string, season, episode int) bool {
	if strings.EqualFold(scope, "movie") {
		return false
	}
	if strings.EqualFold(scope, "episode") || strings.EqualFold(scope, "pack") {
		return true
	}
	if season > 0 || episode > 0 {
		return true
	}
	return seriesPattern.MatchString(filename)
}

type Bot struct {
	teleBot     *tele.Bot
	pool        *pool.WorkerPool
	resolver    *resolver.Resolver
	cache       *cache.MemoryCache
	resolveSlot chan struct{}
	seriesCache sync.Map
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
	b.teleBot.Handle("/zip", b.handleZipCommand)
	b.teleBot.Handle("/zips", b.handleZipCommand)
	b.teleBot.Handle(tele.OnText, b.handleText)
	b.teleBot.Handle(tele.OnCallback, b.handleCallback)
}

func (b *Bot) handleStart(c tele.Context) error {
	msg := `⚡ <b>High-Speed Link & Media Bot (4KHub4U + XDMovies)</b>

Powered by Go Goroutines, Channels, and In-Memory Caching:
• <b>📦 Only Zips Mode:</b> Send <code>/zip &lt;title&gt;</code> to get <b>ONLY Season Zip Packs</b> filtered by Season & Quality (4K, 1080p, 720p, 480p) without any episode clutter!
• <b>4KHub4U & XDMovies:</b> Send any series URL or title to choose interactive Season, Quality, or Zip packs!
• <b>Auto-Scrape:</b> Automatically scrapes new titles on-demand in cloud if not yet cached!
• <b>Parallel Shortener Resolver:</b> Resolves mediator links concurrently into direct HubCloud links.
• <b>Microsecond Cache:</b> Stored links return in &lt;1ms.

👉 <b>Try sending:</b>
1. Only Zips command: <code>/zip Dhindora</code> or <code>/zip Mirzapur</code>
2. Any series/movie title: <code>Dhindora</code>, <code>Mirzapur</code>, or <code>Avatar</code>
3. An XDMovies series link:
<code>https://huh.xdmovies.wtf/series/dhindora-2160p-1080p-hindi-download-275204</code>`
	return c.Send(msg, tele.ModeHTML)
}

func (b *Bot) handleHelp(c tele.Context) error {
	msg := `📖 <b>Usage Guidelines</b>

<b>1. 📦 Only Zips (by Quality & Season):</b>
Send <code>/zip &lt;title or url&gt;</code> (e.g. <code>/zip Dhindora</code>) to immediately browse and deliver ONLY Complete Season Zip packs by quality (4K, 1080p, 720p, 480p).

<b>2. Series / Movie Pages:</b>
Paste any series URL to get interactive buttons:
• <code>[ 📦 ONLY Season Zips by Quality & Season ]</code>
• <code>[ ⚡ Deliver ALL Season Zips Only ]</code>
• <code>[ 📺 Season 1 ]</code> <code>[ 📺 Season 2 ]</code>

<b>3. Download Links:</b>
Paste mediator links to resolve them into direct HubCloud destinations.`
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
	lowerText := strings.ToLower(text)

	// If user specifically asked for zip in text: e.g. "zip dhindora" or "dhindora zip"
	if strings.HasPrefix(lowerText, "zip ") {
		q := strings.TrimSpace(text[4:])
		if q != "" {
			return b.handleZipSearch(c, q)
		}
	}
	if strings.HasSuffix(lowerText, " zip") {
		q := strings.TrimSpace(text[:len(text)-4])
		if q != "" {
			return b.handleZipSearch(c, q)
		}
	}

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
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
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
		errMsg := fmt.Sprintf("❌ <b>Could not retrieve releases for:</b>\n<code>%s</code>\n\n<i>Reason: %s</i>\n\n👉 <i>Try sending another 4KHub4U or XDMovies link or movie/series title!</i>",
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

func (b *Bot) handleZipCommand(c tele.Context) error {
	args := strings.TrimSpace(c.Message().Payload)
	if args == "" {
		msg := `📦 <b>Complete Season Packs (Zips Only)</b>

Send any TV Series title or link to get <b>ONLY Season Zip Packs</b> filtered by Quality and Season without any episode clutter!

👉 <b>Try sending:</b>
• <code>/zip Dhindora</code>
• <code>/zip Mirzapur</code>
• <code>/zip https://huh.xdmovies.wtf/series/dhindora-2160p-1080p-hindi-download-275204</code>`
		return c.Send(msg, tele.ModeHTML)
	}

	return b.handleZipSearch(c, args)
}

func (b *Bot) handleZipSearch(c tele.Context, query string) error {
	statusMsg, _ := b.teleBot.Send(c.Recipient(), fmt.Sprintf("🔍 <i>Searching catalogue for Season Zips of '<b>%s</b>'...</i>", html.EscapeString(query)), tele.ModeHTML)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	var series *resolver.SeriesResult
	var err error

	matches := urlRegex.FindAllString(query, -1)
	if len(matches) > 0 && b.resolver.IsContentPage(matches[0]) {
		series, err = b.resolver.GetSeriesReleases(ctx, matches[0])
	} else {
		series, err = b.resolver.SearchByTitle(ctx, query)
	}

	if err != nil {
		if statusMsg != nil {
			_, _ = b.teleBot.Edit(statusMsg, err.Error(), tele.ModeHTML)
			return nil
		}
		return c.Send(err.Error(), tele.ModeHTML)
	}

	if len(series.Packs) == 0 {
		msg := fmt.Sprintf("⚠️ <b>No Complete Season Zip Packs found for '%s'.</b>\n\n<i>This title only has individual episodes or is a standalone movie. (Total releases: %d)</i>", html.EscapeString(series.Title), series.Total)
		if statusMsg != nil {
			_, _ = b.teleBot.Edit(statusMsg, msg, tele.ModeHTML)
			return nil
		}
		return c.Send(msg, tele.ModeHTML)
	}

	seriesKey := makeSeriesKey(series)
	b.seriesCache.Store(seriesKey, series)

	text := b.formatZipNavigatorText(series)
	menu := b.buildZipNavigatorMenu(seriesKey, series)

	if statusMsg != nil {
		if _, err := b.teleBot.Edit(statusMsg, text, menu, tele.ModeHTML); err == nil {
			return nil
		}
	}
	_, err = b.teleBot.Send(c.Recipient(), text, menu, tele.ModeHTML)
	return err
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
				dest := cleanURL(m.ProviderURL)
				if dest == "" && m.MediatorURL != "" {
					if cached, hit, err := b.cache.GetL1(m.MediatorURL); hit && err == nil && isDirectHubCloud(cached) {
						dest = cleanURL(cached)
					} else {
						dest = cleanURL(m.MediatorURL)
					}
				}
				sizeStr := m.SizeDisplay
				sizeLine := ""
				if sizeStr != "" {
					sizeLine = fmt.Sprintf("   ├ 💾 <b>Size:</b> %s\n", sizeStr)
				}
				if isDirectHubCloud(dest) {
					sb.WriteString(fmt.Sprintf("📄 <code>%s</code>\n%s   └ ⚡ <b>Direct HubCloud:</b> <a href=\"%s\">%s</a>\n\n",
						html.EscapeString(name), sizeLine, html.EscapeString(dest), html.EscapeString(dest)))
				} else {
					sb.WriteString(fmt.Sprintf("📄 <code>%s</code>\n%s   └ 🔗 <b>Mediator Link:</b> <a href=\"%s\">%s</a>\n\n",
						html.EscapeString(name), sizeLine, html.EscapeString(dest), html.EscapeString(dest)))
				}
			}
		}

		if statusMsg != nil {
			if _, editErr := b.teleBot.Edit(statusMsg, sb.String(), tele.ModeHTML); editErr == nil {
				return nil
			} else {
				log.Printf("[Bot] Edit statusMsg movie error: %v, sending via safe chunker", editErr)
			}
		}
		b.sendTelegramMessage(c.Recipient(), sb.String())
		return nil
	}

	// Case B: TV Series
	seasonsList := getAvailableSeasons(series)

	// If it's a small series (<= 8 items total, single season, no packs), display directly
	if len(seasonsList) <= 1 && len(series.Packs) == 0 && len(series.Episodes) <= 8 {
		msgBlocks := b.formatSeriesBlocks(series, 0, "all")
		var fullSB strings.Builder
		fullSB.WriteString(fmt.Sprintf("🔥 <b>%s</b>\n", html.EscapeString(series.Title)))
		fullSB.WriteString(fmt.Sprintf("⚡ <i>Retrieved in %s</i>\n", formatDuration(duration)))
		fullSB.WriteString(fmt.Sprintf("📁 <b>Available Releases:</b> %d\n", series.Total))
		fullSB.WriteString("━━━━━━━━━━━━━━━━━━━━━━\n\n")
		for _, blk := range msgBlocks {
			fullSB.WriteString(blk)
		}
		if statusMsg != nil {
			if _, err := b.teleBot.Edit(statusMsg, fullSB.String(), tele.ModeHTML); err == nil {
				return nil
			}
		}
		b.sendTelegramMessage(c.Recipient(), fullSB.String())
		return nil
	}

	// Interactive Menu Mode: Store series in memory cache and present selection buttons
	seriesKey := makeSeriesKey(series)
	b.seriesCache.Store(seriesKey, series)

	var sbOverview strings.Builder
	sbOverview.WriteString(fmt.Sprintf("🔥 <b>%s</b>\n", html.EscapeString(series.Title)))
	sbOverview.WriteString(fmt.Sprintf("⚡ <i>Retrieved in %s</i>\n", formatDuration(duration)))
	if len(seasonsList) > 1 {
		var sNames []string
		for _, s := range seasonsList {
			sNames = append(sNames, fmt.Sprintf("Season %d", s))
		}
		sbOverview.WriteString(fmt.Sprintf("🗓️ <b>Available Seasons:</b> %s (%d Seasons)\n", strings.Join(sNames, ", "), len(seasonsList)))
	} else if len(seasonsList) == 1 {
		sbOverview.WriteString(fmt.Sprintf("🗓️ <b>Available Season:</b> Season %d\n", seasonsList[0]))
	}
	sbOverview.WriteString(fmt.Sprintf("📁 <b>Total Items:</b> %d (%d Season Packs + %d Episodes)\n",
		series.Total, len(series.Packs), len(series.Episodes)))
	sbOverview.WriteString("━━━━━━━━━━━━━━━━━━━━━━\n")
	sbOverview.WriteString("👇 <b>Select an option below:</b>")

	menu := b.buildSeriesMainMenu(seriesKey, series, seasonsList)

	if statusMsg != nil {
		if _, err := b.teleBot.Edit(statusMsg, sbOverview.String(), menu, tele.ModeHTML); err == nil {
			return nil
		}
	}

	_, err := b.teleBot.Send(c.Recipient(), sbOverview.String(), menu, tele.ModeHTML)
	return err
}

func makeSeriesKey(series *resolver.SeriesResult) string {
	h := sha256.Sum256([]byte(series.URL + "::" + series.Title))
	return hex.EncodeToString(h[:])[:8]
}

func getAvailableSeasons(series *resolver.SeriesResult) []int {
	seasonsMap := make(map[int]bool)
	for _, p := range series.Packs {
		s := p.Season
		if s <= 0 {
			s = 1
		}
		seasonsMap[s] = true
	}
	for _, ep := range series.Episodes {
		s := ep.Season
		if s <= 0 {
			s = 1
		}
		seasonsMap[s] = true
	}
	var seasons []int
	for s := range seasonsMap {
		seasons = append(seasons, s)
	}
	sort.Ints(seasons)
	return seasons
}

func countSeasonItems(series *resolver.SeriesResult, season int) int {
	return countSeasonPacks(series, season) + countSeasonEpisodes(series, season)
}

func countSeasonPacks(series *resolver.SeriesResult, season int) int {
	count := 0
	for _, p := range series.Packs {
		s := p.Season
		if s <= 0 {
			s = 1
		}
		if s == season {
			count++
		}
	}
	return count
}

func countSeasonEpisodes(series *resolver.SeriesResult, season int) int {
	count := 0
	for _, ep := range series.Episodes {
		s := ep.Season
		if s <= 0 {
			s = 1
		}
		if s == season {
			count++
		}
	}
	return count
}

type QualitySummary struct {
	Tag   string // e.g. "4k", "1080p", "720p", "480p"
	Label string // e.g. "4K (2160p)", "1080p", "720p", "480p"
	Rank  int
	Count int
}

func getPackQualityTag(filename, quality string) (string, string, int) {
	lowerFile := strings.ToLower(filename)
	lowerQ := strings.ToLower(quality)

	if strings.Contains(lowerFile, "2160p") || strings.Contains(lowerFile, "4k") || strings.Contains(lowerQ, "2160") || strings.Contains(lowerQ, "4k") {
		return "4k", "4K UHD (2160p)", 400
	}
	if strings.Contains(lowerFile, "1080p") || strings.Contains(lowerQ, "1080") {
		if strings.Contains(lowerFile, "hevc") || strings.Contains(lowerFile, "h.265") || strings.Contains(lowerFile, "h265") || strings.Contains(lowerFile, "x265") {
			return "1080p", "1080p HEVC", 310
		}
		return "1080p", "1080p FHD", 300
	}
	if strings.Contains(lowerFile, "720p") || strings.Contains(lowerQ, "720") {
		if strings.Contains(lowerFile, "hevc") || strings.Contains(lowerFile, "h.265") || strings.Contains(lowerFile, "h265") || strings.Contains(lowerFile, "x265") {
			return "720p", "720p HEVC", 210
		}
		return "720p", "720p HD", 200
	}
	if strings.Contains(lowerFile, "480p") || strings.Contains(lowerQ, "480") {
		return "480p", "480p SD", 100
	}
	return "other", "Standard", 50
}

func getAvailableZipQualities(series *resolver.SeriesResult, season int) []QualitySummary {
	qMap := make(map[string]*QualitySummary)
	var qKeys []string

	for _, p := range series.Packs {
		s := p.Season
		if s <= 0 {
			s = 1
		}
		if season > 0 && s != season {
			continue
		}
		tag, label, rank := getPackQualityTag(p.Filename, p.Quality)
		if qMap[tag] == nil {
			qMap[tag] = &QualitySummary{
				Tag:   tag,
				Label: label,
				Rank:  rank,
			}
			qKeys = append(qKeys, tag)
		}
		qMap[tag].Count++
	}

	sort.Slice(qKeys, func(i, j int) bool {
		return qMap[qKeys[i]].Rank > qMap[qKeys[j]].Rank
	})

	var result []QualitySummary
	for _, k := range qKeys {
		result = append(result, *qMap[k])
	}
	return result
}

func getAvailableSeasonsForPacks(series *resolver.SeriesResult) []int {
	seasonsMap := make(map[int]bool)
	for _, p := range series.Packs {
		s := p.Season
		if s <= 0 {
			s = 1
		}
		seasonsMap[s] = true
	}
	var seasons []int
	for s := range seasonsMap {
		seasons = append(seasons, s)
	}
	sort.Ints(seasons)
	return seasons
}

func (b *Bot) formatZipNavigatorText(series *resolver.SeriesResult) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("📦 <b>%s — Complete Season Packs (Zips)</b>\n\n", html.EscapeString(series.Title)))
	seasonsList := getAvailableSeasonsForPacks(series)
	if len(seasonsList) > 1 {
		var sNames []string
		for _, s := range seasonsList {
			sNames = append(sNames, fmt.Sprintf("Season %d", s))
		}
		sb.WriteString(fmt.Sprintf("🗓️ <b>Available Seasons:</b> %s (%d Seasons)\n", strings.Join(sNames, ", "), len(seasonsList)))
	} else if len(seasonsList) == 1 {
		sb.WriteString(fmt.Sprintf("🗓️ <b>Available Season:</b> Season %d\n", seasonsList[0]))
	}
	sb.WriteString(fmt.Sprintf("📁 <b>Total Season Packs (Zips):</b> %d\n", len(series.Packs)))
	sb.WriteString("━━━━━━━━━━━━━━━━━━━━━━\n")
	sb.WriteString("👇 <b>Select your desired Season and Quality of Zip below:</b>")
	return sb.String()
}

func (b *Bot) buildZipNavigatorMenu(seriesKey string, series *resolver.SeriesResult) *tele.ReplyMarkup {
	menu := &tele.ReplyMarkup{}
	var rows [][]tele.InlineButton

	seasonsList := getAvailableSeasonsForPacks(series)

	for _, s := range seasonsList {
		qualities := getAvailableZipQualities(series, s)
		var qBtns []tele.InlineButton
		for _, q := range qualities {
			btnText := fmt.Sprintf("📦 S%d • %s (%d)", s, q.Label, q.Count)
			if len(seasonsList) == 1 {
				btnText = fmt.Sprintf("📦 %s Zip (%d)", q.Label, q.Count)
			}
			qBtns = append(qBtns, tele.InlineButton{
				Text: btnText,
				Data: fmt.Sprintf("zipq:%d:%s:%s", s, q.Tag, seriesKey),
			})
		}
		for i := 0; i < len(qBtns); i += 2 {
			end := i + 2
			if end > len(qBtns) {
				end = len(qBtns)
			}
			rows = append(rows, qBtns[i:end])
		}
		if len(qualities) > 1 {
			rows = append(rows, []tele.InlineButton{
				{
					Text: fmt.Sprintf("📦 Deliver All Season %d Zips (%d)", s, countSeasonPacks(series, s)),
					Data: fmt.Sprintf("zipq:%d:all:%s", s, seriesKey),
				},
			})
		}
	}

	if len(series.Packs) > 1 && len(seasonsList) > 1 {
		rows = append(rows, []tele.InlineButton{
			{
				Text: fmt.Sprintf("⚡ Deliver ALL Zips (All %d Packs)", len(series.Packs)),
				Data: fmt.Sprintf("zipq:0:all:%s", seriesKey),
			},
		})
	}

	rows = append(rows, []tele.InlineButton{
		{
			Text: "🔙 Back to Full Menu (with Episodes)",
			Data: fmt.Sprintf("back:0:%s", seriesKey),
		},
	})

	menu.InlineKeyboard = rows
	return menu
}

func (b *Bot) buildSeriesMainMenu(seriesKey string, series *resolver.SeriesResult, seasonsList []int) *tele.ReplyMarkup {
	menu := &tele.ReplyMarkup{}
	var rows [][]tele.InlineButton

	// Priority Row 1: If packs exist, prominent "Only Zips" options!
	if len(series.Packs) > 0 {
		rows = append(rows, []tele.InlineButton{
			{
				Text: fmt.Sprintf("📦 ONLY Season Zips by Quality & Season [%d]", len(series.Packs)),
				Data: fmt.Sprintf("zipnav:0:%s", seriesKey),
			},
		})
		rows = append(rows, []tele.InlineButton{
			{
				Text: fmt.Sprintf("⚡ Deliver ALL Season Zips Only [%d]", len(series.Packs)),
				Data: fmt.Sprintf("zipq:0:all:%s", seriesKey),
			},
		})
	}

	// Row 2: Season buttons (Season 1, Season 2, etc.)
	if len(seasonsList) > 1 {
		var sBtns []tele.InlineButton
		for _, s := range seasonsList {
			count := countSeasonItems(series, s)
			pCount := countSeasonPacks(series, s)
			label := fmt.Sprintf("📺 Season %d (%d)", s, count)
			if pCount > 0 {
				label = fmt.Sprintf("📺 Season %d (%d Zips)", s, pCount)
			}
			sBtns = append(sBtns, tele.InlineButton{
				Text: label,
				Data: fmt.Sprintf("menu:%d:%s", s, seriesKey),
			})
		}
		for i := 0; i < len(sBtns); i += 2 {
			end := i + 2
			if end > len(sBtns) {
				end = len(sBtns)
			}
			rows = append(rows, sBtns[i:end])
		}
	} else if len(seasonsList) == 1 {
		s := seasonsList[0]
		epCount := countSeasonEpisodes(series, s)
		if epCount > 0 {
			rows = append(rows, []tele.InlineButton{
				{
					Text: fmt.Sprintf("🎞️ Episodes Only [%d]", epCount),
					Data: fmt.Sprintf("ep:%d:%s", s, seriesKey),
				},
			})
		}
	}

	// Row 3: Deliver Everything button
	rows = append(rows, []tele.InlineButton{
		{
			Text: fmt.Sprintf("🌐 Deliver Everything (Packs + Episodes) [%d]", series.Total),
			Data: fmt.Sprintf("all:0:%s", seriesKey),
		},
	})

	menu.InlineKeyboard = rows
	return menu
}

func (b *Bot) buildSeasonSubmenu(seriesKey string, series *resolver.SeriesResult, season int) *tele.ReplyMarkup {
	menu := &tele.ReplyMarkup{}
	var rows [][]tele.InlineButton

	packsCount := countSeasonPacks(series, season)
	epCount := countSeasonEpisodes(series, season)

	// If packs exist for this season, offer Zip options by Quality!
	if packsCount > 0 {
		qualities := getAvailableZipQualities(series, season)
		var qBtns []tele.InlineButton
		for _, q := range qualities {
			qBtns = append(qBtns, tele.InlineButton{
				Text: fmt.Sprintf("📦 S%d • %s Zip (%d)", season, q.Label, q.Count),
				Data: fmt.Sprintf("zipq:%d:%s:%s", season, q.Tag, seriesKey),
			})
		}
		for i := 0; i < len(qBtns); i += 2 {
			end := i + 2
			if end > len(qBtns) {
				end = len(qBtns)
			}
			rows = append(rows, qBtns[i:end])
		}
		rows = append(rows, []tele.InlineButton{
			{
				Text: fmt.Sprintf("📦 All Season %d Zips (%d)", season, packsCount),
				Data: fmt.Sprintf("zipq:%d:all:%s", season, seriesKey),
			},
		})
	}

	if epCount > 0 {
		rows = append(rows, []tele.InlineButton{
			{
				Text: fmt.Sprintf("🎞️ Season %d Episodes Only (%d)", season, epCount),
				Data: fmt.Sprintf("ep:%d:%s", season, seriesKey),
			},
		})
	}

	rows = append(rows, []tele.InlineButton{
		{
			Text: fmt.Sprintf("⚡ Deliver Everything Season %d (%d)", season, packsCount+epCount),
			Data: fmt.Sprintf("all:%d:%s", season, seriesKey),
		},
	})

	rows = append(rows, []tele.InlineButton{
		{
			Text: "🔙 Back to Seasons",
			Data: fmt.Sprintf("back:0:%s", seriesKey),
		},
	})

	menu.InlineKeyboard = rows
	return menu
}

func (b *Bot) formatSeriesBlocks(series *resolver.SeriesResult, targetSeason int, filterType string) []string {
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

	// 1. Add all Season Packs (if not episodes-only)
	if filterType != "episodes" {
		for _, p := range series.Packs {
			s := p.Season
			if s <= 0 {
				s = 1
			}
			if targetSeason > 0 && s != targetSeason {
				continue
			}
			dest := p.ProviderURL
			if dest == "" {
				dest = p.MediatorURL
			}
			if dest == "" || strings.Contains(strings.ToLower(dest), "hubdrive") || strings.EqualFold(p.Provider, "HubDrive") {
				continue
			}
			sg := getOrCreateSeason(s)
			qs := getOrCreateQuality(sg, p.Filename, p.Quality)
			qs.Packs = append(qs.Packs, p)
		}
	}

	// 2. Add all Episodes (if not packs-only)
	if filterType != "packs" {
		for _, ep := range series.Episodes {
			s := ep.Season
			if s <= 0 {
				s = 1
			}
			if targetSeason > 0 && s != targetSeason {
				continue
			}
			dest := ep.ProviderURL
			if dest == "" {
				dest = ep.MediatorURL
			}
			if dest == "" || strings.Contains(strings.ToLower(dest), "hubdrive") || strings.EqualFold(ep.Provider, "HubDrive") {
				continue
			}
			sg := getOrCreateSeason(s)
			qs := getOrCreateQuality(sg, ep.Filename, ep.Quality)
			qs.Episodes = append(qs.Episodes, ep)
		}
	}

	sort.Ints(seasonsList)

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
					dest := cleanURL(p.ProviderURL)
					if dest == "" && p.MediatorURL != "" {
						if cached, hit, err := b.cache.GetL1(p.MediatorURL); hit && err == nil && isDirectHubCloud(cached) {
							dest = cleanURL(cached)
						} else {
							dest = cleanURL(p.MediatorURL)
						}
					}
					sizeStr := p.SizeDisplay
					sizeLine := ""
					if sizeStr != "" {
						sizeLine = fmt.Sprintf("   ├ 💾 <b>Size:</b> %s\n", sizeStr)
					}
					if isDirectHubCloud(dest) {
						qSB.WriteString(fmt.Sprintf("📁 <code>%s</code>\n%s   └ ⚡ <b>Direct HubCloud:</b> <a href=\"%s\">%s</a>\n\n",
							html.EscapeString(name), sizeLine, html.EscapeString(dest), html.EscapeString(dest)))
					} else {
						qSB.WriteString(fmt.Sprintf("📁 <code>%s</code>\n%s   └ 🔗 <b>Mediator Link:</b> <a href=\"%s\">%s</a>\n\n",
							html.EscapeString(name), sizeLine, html.EscapeString(dest), html.EscapeString(dest)))
					}
				}
			}

			// Individual episodes
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
					dest := cleanURL(ep.ProviderURL)
					if dest == "" && ep.MediatorURL != "" {
						if cached, hit, err := b.cache.GetL1(ep.MediatorURL); hit && err == nil && isDirectHubCloud(cached) {
							dest = cleanURL(cached)
						} else {
							dest = cleanURL(ep.MediatorURL)
						}
					}
					sizeStr := ep.SizeDisplay
					sizeLine := ""
					if sizeStr != "" {
						sizeLine = fmt.Sprintf("   ├ 💾 <b>Size:</b> %s\n", sizeStr)
					}
					if isDirectHubCloud(dest) {
						qSB.WriteString(fmt.Sprintf("📄 <code>%s</code>\n%s   └ ⚡ <b>Direct HubCloud:</b> <a href=\"%s\">%s</a>\n\n",
							html.EscapeString(name), sizeLine, html.EscapeString(dest), html.EscapeString(dest)))
					} else {
						qSB.WriteString(fmt.Sprintf("📄 <code>%s</code>\n%s   └ 🔗 <b>Mediator Link:</b> <a href=\"%s\">%s</a>\n\n",
							html.EscapeString(name), sizeLine, html.EscapeString(dest), html.EscapeString(dest)))
					}
				}
			}

			if len(qs.Packs) > 0 || len(qs.Episodes) > 0 {
				msgBlocks = append(msgBlocks, qSB.String())
			}
		}
	}

	return msgBlocks
}

func (b *Bot) formatZipBlocks(series *resolver.SeriesResult, targetSeason int, targetQuality string) []string {
	type qualityGroup struct {
		Category string
		Rank     int
		Packs    []resolver.StoredLink
	}

	type seasonZipGroup struct {
		Season      int
		Qualities   map[string]*qualityGroup
		QualityKeys []string
	}

	seasonsMap := make(map[int]*seasonZipGroup)
	var seasonsList []int

	getOrCreateSeason := func(s int) *seasonZipGroup {
		if s <= 0 {
			s = 1
		}
		if seasonsMap[s] == nil {
			seasonsMap[s] = &seasonZipGroup{
				Season:    s,
				Qualities: make(map[string]*qualityGroup),
			}
			seasonsList = append(seasonsList, s)
		}
		return seasonsMap[s]
	}

	for _, p := range series.Packs {
		s := p.Season
		if s <= 0 {
			s = 1
		}
		if targetSeason > 0 && s != targetSeason {
			continue
		}
		dest := p.ProviderURL
		if dest == "" {
			dest = p.MediatorURL
		}
		if dest == "" || strings.Contains(strings.ToLower(dest), "hubdrive") || strings.EqualFold(p.Provider, "HubDrive") {
			continue
		}

		tag, cat, rank := getPackQualityTag(p.Filename, p.Quality)
		if targetQuality != "all" && targetQuality != "" && tag != targetQuality {
			continue
		}

		sg := getOrCreateSeason(s)
		if sg.Qualities[cat] == nil {
			sg.Qualities[cat] = &qualityGroup{
				Category: cat,
				Rank:     rank,
			}
			sg.QualityKeys = append(sg.QualityKeys, cat)
		}
		sg.Qualities[cat].Packs = append(sg.Qualities[cat].Packs, p)
	}

	sort.Ints(seasonsList)

	var msgBlocks []string
	for _, s := range seasonsList {
		sg := seasonsMap[s]
		sort.Slice(sg.QualityKeys, func(i, j int) bool {
			return sg.Qualities[sg.QualityKeys[i]].Rank > sg.Qualities[sg.QualityKeys[j]].Rank
		})

		for _, qKey := range sg.QualityKeys {
			qg := sg.Qualities[qKey]
			var qSB strings.Builder
			qSB.WriteString(fmt.Sprintf("📦 <b>════ SEASON %d • %s COMPLETE PACK ════</b>\n\n", s, qg.Category))

			for _, p := range qg.Packs {
				name := p.Filename
				if name == "" {
					name = p.Title
				}
				dest := cleanURL(p.ProviderURL)
				if dest == "" && p.MediatorURL != "" {
					if cached, hit, err := b.cache.GetL1(p.MediatorURL); hit && err == nil && isDirectHubCloud(cached) {
						dest = cleanURL(cached)
					} else {
						dest = cleanURL(p.MediatorURL)
					}
				}
				sizeStr := p.SizeDisplay
				sizeLine := ""
				if sizeStr != "" {
					sizeLine = fmt.Sprintf("   ├ 💾 <b>Size:</b> %s\n", sizeStr)
				}
				if isDirectHubCloud(dest) {
					qSB.WriteString(fmt.Sprintf("📁 <code>%s</code>\n%s   └ ⚡ <b>Direct HubCloud:</b> <a href=\"%s\">%s</a>\n\n",
						html.EscapeString(name), sizeLine, html.EscapeString(dest), html.EscapeString(dest)))
				} else {
					qSB.WriteString(fmt.Sprintf("📁 <code>%s</code>\n%s   └ 🔗 <b>Mediator Link:</b> <a href=\"%s\">%s</a>\n\n",
						html.EscapeString(name), sizeLine, html.EscapeString(dest), html.EscapeString(dest)))
				}
			}

			if len(qg.Packs) > 0 {
				msgBlocks = append(msgBlocks, qSB.String())
			}
		}
	}

	return msgBlocks
}

func (b *Bot) handleCallback(c tele.Context) error {
	cb := c.Callback()
	if cb == nil {
		return nil
	}
	data := strings.TrimSpace(cb.Data)
	if data == "" {
		return c.Respond()
	}

	parts := strings.Split(data, ":")
	if len(parts) < 3 {
		return c.Respond()
	}

	action := parts[0]
	seasonNum, _ := strconv.Atoi(parts[1])
	qualityTag := "all"
	seriesKey := ""
	if len(parts) >= 4 {
		qualityTag = parts[2]
		seriesKey = parts[3]
	} else {
		seriesKey = parts[2]
	}

	val, ok := b.seriesCache.Load(seriesKey)
	if !ok {
		return c.Respond(&tele.CallbackResponse{
			Text:      "⚠️ Selection session expired. Please re-send the series URL or title.",
			ShowAlert: true,
		})
	}
	series := val.(*resolver.SeriesResult)

	switch action {
	case "zipnav":
		menu := b.buildZipNavigatorMenu(seriesKey, series)
		text := b.formatZipNavigatorText(series)
		_ = c.Respond()
		if cb.Message != nil {
			_, err := b.teleBot.Edit(cb.Message, text, menu, tele.ModeHTML)
			if err != nil {
				log.Printf("[Bot] Edit zipnav callback error: %v", err)
			}
		}
		return nil

	case "zipq":
		tagLabel := qualityTag
		if qualityTag == "all" {
			tagLabel = "All Qualities"
		} else {
			tagLabel = strings.ToUpper(qualityTag)
		}
		seasonLabel := "All Seasons"
		if seasonNum > 0 {
			seasonLabel = fmt.Sprintf("Season %d", seasonNum)
		}
		_ = c.Respond(&tele.CallbackResponse{Text: fmt.Sprintf("Delivering %s %s Zips...", seasonLabel, tagLabel)})

		blocks := b.formatZipBlocks(series, seasonNum, qualityTag)
		if len(blocks) == 0 {
			b.sendTelegramMessage(c.Recipient(), fmt.Sprintf("⚠️ No %s %s Zip packs found.", seasonLabel, tagLabel))
			return nil
		}

		header := ""
		if seasonNum > 0 {
			header = fmt.Sprintf("📦 <b>%s • %s Complete Packs (Zips Only) — %s:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n",
				seasonLabel, tagLabel, html.EscapeString(series.Title))
		} else {
			header = fmt.Sprintf("📦 <b>Complete Season Packs (Zips Only) — %s:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n",
				html.EscapeString(series.Title))
		}

		b.sendTelegramMessage(c.Recipient(), header+blocks[0])
		for _, blk := range blocks[1:] {
			b.sendTelegramMessage(c.Recipient(), blk)
		}
		return nil

	case "menu":
		submenu := b.buildSeasonSubmenu(seriesKey, series, seasonNum)
		pCount := countSeasonPacks(series, seasonNum)
		epCount := countSeasonEpisodes(series, seasonNum)
		text := fmt.Sprintf("📺 <b>%s • Season %d</b>\n\n📁 <b>Available:</b> %d Season Packs + %d Episodes\n━━━━━━━━━━━━━━━━━━━━━━\n👇 <i>Select what to deliver:</i>",
			html.EscapeString(series.Title), seasonNum, pCount, epCount)
		_ = c.Respond()
		if cb.Message != nil {
			_, err := b.teleBot.Edit(cb.Message, text, submenu, tele.ModeHTML)
			if err != nil {
				log.Printf("[Bot] Edit callback error: %v", err)
			}
		}
		return nil

	case "back":
		seasonsList := getAvailableSeasons(series)
		mainMenu := b.buildSeriesMainMenu(seriesKey, series, seasonsList)
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("🔥 <b>%s</b>\n", html.EscapeString(series.Title)))
		if len(seasonsList) > 1 {
			var sNames []string
			for _, s := range seasonsList {
				sNames = append(sNames, fmt.Sprintf("Season %d", s))
			}
			sb.WriteString(fmt.Sprintf("🗓️ <b>Available Seasons:</b> %s (%d Seasons)\n", strings.Join(sNames, ", "), len(seasonsList)))
		} else if len(seasonsList) == 1 {
			sb.WriteString(fmt.Sprintf("🗓️ <b>Available Season:</b> Season %d\n", seasonsList[0]))
		}
		sb.WriteString(fmt.Sprintf("📁 <b>Total Items:</b> %d (%d Season Packs + %d Episodes)\n",
			series.Total, len(series.Packs), len(series.Episodes)))
		sb.WriteString("━━━━━━━━━━━━━━━━━━━━━━\n")
		sb.WriteString("👇 <b>Select an option below:</b>")

		_ = c.Respond()
		if cb.Message != nil {
			_, err := b.teleBot.Edit(cb.Message, sb.String(), mainMenu, tele.ModeHTML)
			if err != nil {
				log.Printf("[Bot] Edit back callback error: %v", err)
			}
		}
		return nil

	case "packs":
		_ = c.Respond(&tele.CallbackResponse{Text: "Delivering Complete Season Packs (Zips)..."})
		blocks := b.formatZipBlocks(series, seasonNum, "all")
		if len(blocks) == 0 {
			b.sendTelegramMessage(c.Recipient(), "⚠️ No Season Packs found for this selection.")
			return nil
		}
		header := ""
		if seasonNum > 0 {
			header = fmt.Sprintf("📦 <b>Season %d Complete Packs (Zips) - %s:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n", seasonNum, html.EscapeString(series.Title))
		} else {
			header = fmt.Sprintf("📦 <b>Complete Season Packs (Zips) - %s:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n", html.EscapeString(series.Title))
		}
		b.sendTelegramMessage(c.Recipient(), header+blocks[0])
		for _, blk := range blocks[1:] {
			b.sendTelegramMessage(c.Recipient(), blk)
		}
		return nil

	case "ep":
		_ = c.Respond(&tele.CallbackResponse{Text: "Delivering Episodes..."})
		blocks := b.formatSeriesBlocks(series, seasonNum, "episodes")
		if len(blocks) == 0 {
			b.sendTelegramMessage(c.Recipient(), "⚠️ No episodes found for this selection.")
			return nil
		}
		header := ""
		if seasonNum > 0 {
			header = fmt.Sprintf("🎞️ <b>Season %d Episodes - %s:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n", seasonNum, html.EscapeString(series.Title))
		} else {
			header = fmt.Sprintf("🎞️ <b>Episodes - %s:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n", html.EscapeString(series.Title))
		}
		b.sendTelegramMessage(c.Recipient(), header+blocks[0])
		for _, blk := range blocks[1:] {
			b.sendTelegramMessage(c.Recipient(), blk)
		}
		return nil

	case "all":
		_ = c.Respond(&tele.CallbackResponse{Text: "Delivering releases..."})
		blocks := b.formatSeriesBlocks(series, seasonNum, "all")
		if len(blocks) == 0 {
			b.sendTelegramMessage(c.Recipient(), "⚠️ No releases found for this selection.")
			return nil
		}
		header := ""
		if seasonNum > 0 {
			header = fmt.Sprintf("📺 <b>Season %d All Releases - %s:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n", seasonNum, html.EscapeString(series.Title))
		} else {
			header = fmt.Sprintf("🔥 <b>%s - All Releases (%d):</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n", html.EscapeString(series.Title), series.Total)
		}
		b.sendTelegramMessage(c.Recipient(), header+blocks[0])
		for _, blk := range blocks[1:] {
			b.sendTelegramMessage(c.Recipient(), blk)
		}
		return nil
	}

	return c.Respond()
}

func cleanURL(u string) string {
	return strings.Trim(strings.TrimSpace(u), "\"' \t\r\n")
}

func isDirectHubCloud(urlStr string) bool {
	clean := cleanURL(urlStr)
	lower := strings.ToLower(clean)
	return strings.Contains(lower, "hubcloud") && (strings.Contains(lower, "/drive/") || strings.Contains(lower, "/file/"))
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

func (b *Bot) sendTelegramMessage(recipient tele.Recipient, text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	for len(text) > 0 {
		chunk := text
		if len(chunk) > 3500 {
			idx := strings.LastIndex(chunk[:3500], "\n\n")
			if idx == -1 {
				idx = strings.LastIndex(chunk[:3500], "\n")
			}
			if idx == -1 {
				idx = 3500
			}
			chunk = strings.TrimSpace(text[:idx])
			text = strings.TrimSpace(text[idx:])
		} else {
			text = ""
		}
		if chunk == "" {
			continue
		}
		var err error
		for attempt := 0; attempt < 3; attempt++ {
			_, err = b.teleBot.Send(recipient, chunk, tele.ModeHTML)
			if err == nil {
				break
			}
			errLower := strings.ToLower(err.Error())
			if strings.Contains(errLower, "flood") || strings.Contains(errLower, "too many requests") || strings.Contains(errLower, "retry after") {
				log.Printf("[Bot] Telegram rate limit encountered: %v. Backing off 2.5s before retry...", err)
				time.Sleep(2500 * time.Millisecond)
				continue
			}
			log.Printf("[Bot] HTML send failed: %v, retrying plain text", err)
			_, err = b.teleBot.Send(recipient, chunk)
			if err == nil {
				break
			}
			time.Sleep(1 * time.Second)
		}
		if err != nil {
			log.Printf("[Bot] Failed to send message chunk after retries: %v", err)
		}
		time.Sleep(600 * time.Millisecond)
	}
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
					dest := cleanURL(res.Destination)
					if strings.Contains(dest, "hubcloud") {
						sb.WriteString(fmt.Sprintf("<b>#%d:</b> ⚡ <a href=\"%s\"><b>Direct HubCloud Link</b></a>\n<code>%s</code>\n\n", i+1, html.EscapeString(dest), html.EscapeString(dest)))
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
				resolveTimeout = 150 * time.Second
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

	type batchMovieQualitySection struct {
		Category string
		Rank     int
		Links    []resolvedMetaItem
	}
	bMovieQualities := make(map[string]*batchMovieQualitySection)
	var bMovieQualityKeys []string

	getOrCreateBatchMovieQuality := func(filename, quality string) *batchMovieQualitySection {
		cat, rank := getReleaseCategory(filename, quality)
		if bMovieQualities[cat] == nil {
			bMovieQualities[cat] = &batchMovieQualitySection{
				Category: cat,
				Rank:     rank,
			}
			bMovieQualityKeys = append(bMovieQualityKeys, cat)
		}
		return bMovieQualities[cat]
	}

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
		} else if !isSeriesRelease(it.Item.Scope, it.Item.Filename, it.Item.Season, it.Item.Episode) {
			bmq := getOrCreateBatchMovieQuality(it.Item.Filename, it.Item.Quality)
			bmq.Links = append(bmq.Links, it)
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

	// Format Movie releases first (clean movie cards without Season/Episode labels)
	if len(bMovieQualityKeys) > 0 {
		sort.Slice(bMovieQualityKeys, func(i, j int) bool {
			return bMovieQualities[bMovieQualityKeys[i]].Rank > bMovieQualities[bMovieQualityKeys[j]].Rank
		})

		for _, catKey := range bMovieQualityKeys {
			bmq := bMovieQualities[catKey]
			var mSB strings.Builder
			mSB.WriteString(fmt.Sprintf("🎬 <b>════ %s ════</b>\n\n", bmq.Category))
			for _, m := range bmq.Links {
				name := m.Item.Filename
				if name == "" {
					name = m.Item.Title
				}
				dest := cleanURL(m.Result.Destination)
				sizeStr := m.Item.SizeDisplay
				sizeLine := ""
				if sizeStr != "" {
					sizeLine = fmt.Sprintf("   ├ 💾 <b>Size:</b> %s\n", sizeStr)
				}
				mSB.WriteString(fmt.Sprintf("📄 <code>%s</code>\n%s   └ ⚡ <b>Direct HubCloud:</b> <a href=\"%s\">%s</a>\n\n",
					html.EscapeString(name), sizeLine, html.EscapeString(dest), html.EscapeString(dest)))
			}
			msgBlocks = append(msgBlocks, mSB.String())
		}
	}

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
					dest := cleanURL(p.Result.Destination)
					sizeStr := p.Item.SizeDisplay
					sizeLine := ""
					if sizeStr != "" {
						sizeLine = fmt.Sprintf("   ├ 💾 <b>Size:</b> %s\n", sizeStr)
					}
					qSB.WriteString(fmt.Sprintf("📁 <code>%s</code>\n%s   └ ⚡ <b>Direct HubCloud:</b> <a href=\"%s\">%s</a>\n\n",
						html.EscapeString(name), sizeLine, html.EscapeString(dest), html.EscapeString(dest)))
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
					dest := cleanURL(ep.Result.Destination)
					sizeStr := ep.Item.SizeDisplay
					sizeLine := ""
					if sizeStr != "" {
						sizeLine = fmt.Sprintf("   ├ 💾 <b>Size:</b> %s\n", sizeStr)
					}
					qSB.WriteString(fmt.Sprintf("📄 <code>%s</code>\n%s   └ ⚡ <b>Direct HubCloud:</b> <a href=\"%s\">%s</a>\n\n",
						html.EscapeString(name), sizeLine, html.EscapeString(dest), html.EscapeString(dest)))
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
				errStr := res.Err.Error()
				if strings.Contains(errStr, "<launching>") || strings.Contains(errStr, "chrome-linux64") || strings.Contains(errStr, "Command failed:") || len(errStr) > 200 {
					errStr = "Resolution timed out during verification challenge"
				}
				oSB.WriteString(fmt.Sprintf("<b>#%d:</b> ⚠️ <b>Resolution Failed</b>: %s\n\n", i+1, html.EscapeString(errStr)))
			} else {
				dest := cleanURL(res.Destination)
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
						i+1, tag, html.EscapeString(dest), titleLine, html.EscapeString(dest), formatDuration(res.Duration)))
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

	for _, block := range msgBlocks {
		b.sendTelegramMessage(c.Recipient(), block)
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
