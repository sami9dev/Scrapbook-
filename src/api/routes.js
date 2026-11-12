import express from 'express';
import { validateUrl, normalizeNexdriveUrl } from '../utils/url.js';
import { jobQueue } from '../queue/job-queue.js';
import { jobsRepo, scrapedLinksRepo } from '../database/models.js';
import { logger } from '../logging/logger.js';
import { matchesQuality } from '../utils/normalize.js';
import { mediatorResolutionSemaphore, runBoundedWithBrowser } from '../utils/concurrency.js';
import { config } from '../config/config.js';

const router = express.Router();

/**
 * POST /api/scrape
 * Submits an authorized URL to be scraped.
 */
router.post('/scrape', async (req, res) => {
  const { url, quality, targetQuality, scope, targetScope, reset, autoReset } = req.body;
  const selectedQuality = quality || targetQuality || 'all';
  const selectedScope = scope || targetScope || 'all';

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Field "url" is required and must be a string.' });
  }

  const trimmedInput = url.trim();
  let targetUrl = trimmedInput;
  let matchedTitle = null;

  // Check if input is a direct URL or a search query / title
  const isUrl = /^https?:\/\//i.test(trimmedInput);
  if (!isUrl) {
    try {
      // 1. Check if the title exists in the catalog store with a known URL first
      const { loadRawCatalog } = await import('../utils/catalog-store.js');
      const catalog = loadRawCatalog();
      const catalogMatch = catalog.find(
        (c) => c.title && c.title.toLowerCase().trim() === trimmedInput.toLowerCase().trim() && c.url
      );

      if (catalogMatch && catalogMatch.url) {
        targetUrl = catalogMatch.url;
        matchedTitle = catalogMatch.title;
        logger.discovered(`Catalog match for "${trimmedInput}" -> ${targetUrl} (${catalogMatch.platform})`);
      } else {
        // 2. Search 4KHDHub & XDMovies
        const { search4KHDHub } = await import('../providers/4khdhub/search.js');
        const { searchXDMovies } = await import('../scrapers/xdmovies/search.js');
        const [hubResult, xdResult] = await Promise.all([
          search4KHDHub(trimmedInput).catch(() => null),
          searchXDMovies(trimmedInput).catch(() => null),
        ]);

        let chosenResult = null;
        let chosenPlatform = '';

        if (hubResult?.success && hubResult?.bestMatch) {
          chosenResult = hubResult.bestMatch;
          chosenPlatform = '4KHDHub';
        } else if (xdResult?.success && xdResult?.bestMatch) {
          chosenResult = xdResult.bestMatch;
          chosenPlatform = 'XDMovies';
        }

        if (!chosenResult) {
          return res.status(404).json({
            error: `No movie or series found on 4KHDHub or XDMovies for title: "${trimmedInput}". Please enter a valid URL or try another title.`,
          });
        }
        targetUrl = chosenResult.url;
        matchedTitle = chosenResult.title;
        logger.discovered(`Title search "${trimmedInput}" matched "${matchedTitle}" on ${chosenPlatform} (${targetUrl})`);
      }
    } catch (searchErr) {
      logger.error(`Error searching title for scrape: ${searchErr.message}`);
      return res.status(500).json({ error: `Search failed: ${searchErr.message}` });
    }
  }

  // Validate URL and SSRF controls
  const validation = validateUrl(targetUrl);
  if (!validation.valid) {
    logger.security(`Rejected invalid or dangerous scrape URL: ${targetUrl} (${validation.error})`);
    return res.status(400).json({ error: validation.error });
  }

  try {
    if (reset || autoReset) {
      jobQueue.cancelAll();
      await scrapedLinksRepo.clear({ sourceUrl: validation.normalizedUrl });
      await jobsRepo.clear({ url: validation.normalizedUrl });
      logger.database(`Reset completed for sourceUrl: ${validation.normalizedUrl}`);
    }

    const job = await jobQueue.addJob(validation.normalizedUrl, { quality: selectedQuality, scope: selectedScope });
    return res.status(202).json({
      jobId: job._id,
      status: job.status,
      url: job.url,
      matchedTitle,
      targetQuality: job.targetQuality,
      targetScope: job.targetScope,
      createdAt: job.createdAt,
    });
  } catch (err) {
    logger.error(`Error enqueuing scrape job: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error enqueuing scrape job.' });
  }
});

/**
 * POST /api/scrape-page
 * Fast-path HTTP catalogue scrape for movies/series pages without headless browser.
 * Fetches page HTML directly via standard HTTP (max 8-10s).
 * If Cloudflare challenge detected, fails fast without launching a browser.
 * If release cards (.pack-card, .episode-card, .download-item) found, extracts and saves all releases.
 */
router.post('/scrape-page', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Field "url" is required and must be a string.' });
  }

  const targetUrl = url.trim();
  const scrapeStart = Date.now();
  const isXDMovies = /xdmovies\.[a-z0-9.]+|huh\.xdmovies|link\.xdmovies|top\.xdmovies/i.test(targetUrl);
  const platform = isXDMovies ? 'XDMovies' : '4KHub4U';
  logger.log(platform, `[scrape-page] Starting fast-path fetch for: ${targetUrl}`);

  try {
    let html = '';

    if (isXDMovies) {
      // 1. Try quick HTTP fetch first (< 4s)
      try {
        const pageResponse = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': 'https://huh.xdmovies.wtf/',
          },
          signal: AbortSignal.timeout(4000),
        });
        if (pageResponse.ok) {
          const body = await pageResponse.text();
          if (!body.includes('Just a moment...') && !body.includes('cf-turnstile') && !body.includes('security verification')) {
            html = body;
          }
        }
      } catch {}

      // 2. If Cloudflare challenge or fetch failed, use stealth fetcher
      if (!html || html.length < 500) {
        logger.log('XDMovies', `[scrape-page] Fetching XDMovies page via stealth resolver...`);
        const { fetchXDMoviesPage } = await import('../scrapers/xdmovies/browser-fetch.js');
        const bfRes = await fetchXDMoviesPage(targetUrl, { timeoutMs: 65000 });
        if (bfRes.success && bfRes.html && bfRes.html.length > 500) {
          html = bfRes.html;
        } else {
          return res.json({
            success: false,
            challenge: true,
            error: bfRes.error || 'Failed to bypass XDMovies security verification',
          });
        }
      }
    } else {
      const fetchController = new AbortController();
      const fetchTimeout = setTimeout(() => fetchController.abort(new Error('HTTP fetch timed out')), 9000);
      fetchTimeout.unref?.();

      let pageResponse;
      try {
        pageResponse = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
          },
          signal: fetchController.signal,
        });
      } finally {
        clearTimeout(fetchTimeout);
      }

      if (!pageResponse.ok && pageResponse.status !== 200) {
        logger.log('4KHub4U', `[scrape-page] HTTP status ${pageResponse.status} for ${targetUrl}`);
        return res.json({
          success: false,
          challenge: pageResponse.status === 403 || pageResponse.status === 503,
          error: `HTTP ${pageResponse.status}`,
        });
      }

      html = await pageResponse.text();

      // Check for Cloudflare challenge markers
      const isChallenge =
        html.includes('Just a moment...') ||
        html.includes('cf-turnstile') ||
        html.includes('challenges.cloudflare.com') ||
        html.includes('Attention Required! | Cloudflare');

      if (isChallenge) {
        logger.log('4KHub4U', `[scrape-page] Cloudflare challenge detected on ${targetUrl}. Fast aborting without browser.`);
        return res.json({
          success: false,
          challenge: true,
          error: 'Cloudflare challenge page detected',
        });
      }
    }

    // Parse according to platform
    let catalogue;
    const { isHubCloudDriveUrl, extractHubCloudDriveId } = await import('../providers/hubcloud/validator.js');
    const { recordInCatalog } = await import('../utils/catalog-store.js');

    if (isXDMovies) {
      const { parseXDMoviesCatalogue } = await import('../scrapers/xdmovies/catalogue.js');
      catalogue = parseXDMoviesCatalogue(html, targetUrl);
    } else {
      const { parse4KHubCatalogue, resolveCatalogueLinks } = await import('../scrapers/4khub4u/catalogue.js');
      const rawCatalogue = parse4KHubCatalogue(html, targetUrl);
      catalogue = await resolveCatalogueLinks(rawCatalogue, { concurrency: 10, timeout: 5000 }).catch(() => rawCatalogue);
    }

    const isMoviePage = catalogue.type === 'movie';

    recordInCatalog({
      title: catalogue.title || `${platform} Content`,
      url: targetUrl,
      format: isMoviePage ? 'Movie' : 'Series',
      platform,
    });

    const allReleases =
      catalogue.type === 'series' && Array.isArray(catalogue.seasons)
        ? catalogue.seasons.flatMap((s) => s.releases || [])
        : Array.isArray(catalogue.qualities)
        ? catalogue.qualities.flatMap((q) => q.releases || [])
        : [];

    const savedRecords = [];
    for (const rel of allReleases) {
      for (const dl of (rel.downloadLinks || [])) {
        const rawLink = dl.url;
        // STRICT FILTER: HubDrive links are prohibited; only HubCloud links are preserved
        if (!rawLink || /hubdrive/i.test(dl.provider || '') || /hubdrive/i.test(rawLink)) {
          continue;
        }
        const isDirectHubCloud = dl.isDirectDestination || isHubCloudDriveUrl(rawLink) || /hubcloud\.[a-z0-9.]+/i.test(rawLink);
        const providerUrl = isDirectHubCloud ? rawLink : null;
        const mediatorUrl = isDirectHubCloud ? null : rawLink;
        const fileId = isDirectHubCloud ? (extractHubCloudDriveId(rawLink) || rawLink.split('/').pop()) : null;
        const status = isDirectHubCloud ? 'RESOLVED' : 'DISCOVERED';

        const docToSave = {
          sourceUrl: targetUrl,
          sourceDomain: new URL(targetUrl).hostname,
          title: rel.label || catalogue.title,
          filename: rel.filename || rel.label || catalogue.title,
          scope: rel.scope || (isMoviePage ? 'movie' : (rel.episode !== null && rel.episode !== undefined ? 'episode' : 'pack')),
          season: isMoviePage ? null : (rel.season ?? 1),
          episode: isMoviePage ? null : (rel.episode ?? null),
          quality: rel.quality?.normalized || rel.resolution || 'unknown',
          codec: rel.codec || null,
          sizeDisplay: rel.fileSize || null,
          provider: 'HubCloud',
          providerUrl,
          mediatorUrl,
          fileId,
          status,
        };

        const saved = await scrapedLinksRepo.saveLink(docToSave);
        savedRecords.push(saved);
      }
    }

    logger.log('TIMING', `[catalogue-query] ${platform} fast-path scrape url=${targetUrl} totalReleases=${savedRecords.length} took=${Date.now() - scrapeStart}ms`);

    return res.json({
      success: true,
      challenge: false,
      title: catalogue.title,
      type: catalogue.type,
      totalReleases: savedRecords.length,
      records: savedRecords,
    });
  } catch (err) {
    logger.error(`[scrape-page] Fast-path error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/search?q=<query>
 * Searches 4KHDHub and XDMovies for matching movie or series titles.
 */
router.get('/search', async (req, res) => {
  const query = (req.query.q || req.query.query || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required.' });
  }

  try {
    const { search4KHDHub } = await import('../providers/4khdhub/search.js');
    const { searchXDMovies } = await import('../scrapers/xdmovies/search.js');

    const [hubRes, xdRes] = await Promise.all([
      search4KHDHub(query).catch(() => null),
      searchXDMovies(query).catch(() => null),
    ]);

    const results = [];
    if (hubRes?.results) {
      results.push(...hubRes.results.map((r) => ({ ...r, provider: '4KHDHub' })));
    }
    if (xdRes?.results) {
      results.push(...xdRes.results.map((r) => ({ ...r, provider: 'XDMovies' })));
    }

    let bestMatch = null;
    const lowerQuery = query.toLowerCase();
    if (hubRes?.bestMatch && xdRes?.bestMatch) {
      const hubExact = hubRes.bestMatch.title.toLowerCase() === lowerQuery;
      const xdExact = xdRes.bestMatch.title.toLowerCase() === lowerQuery;
      if (xdExact && !hubExact) {
        bestMatch = { ...xdRes.bestMatch, provider: 'XDMovies' };
      } else {
        bestMatch = { ...hubRes.bestMatch, provider: '4KHDHub' };
      }
    } else if (hubRes?.bestMatch) {
      bestMatch = { ...hubRes.bestMatch, provider: '4KHDHub' };
    } else if (xdRes?.bestMatch) {
      bestMatch = { ...xdRes.bestMatch, provider: 'XDMovies' };
    }

    return res.json({
      success: results.length > 0,
      query,
      results,
      bestMatch,
    });
  } catch (err) {
    logger.error(`API search error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/catalog
 * Returns the TV series catalog enriched with scraped link counts.
 */
router.get('/catalog', async (req, res) => {
  try {
    const { getEnrichedCatalog } = await import('../utils/catalog-store.js');
    const enriched = await getEnrichedCatalog();
    return res.json(enriched);
  } catch (err) {
    logger.error(`Error fetching catalog: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/catalog/links?title=<title>
 * Returns all resolved links and pre-formatted text for a given title.
 */
router.get('/catalog/links', async (req, res) => {
  const title = (req.query.title || '').trim();
  if (!title) {
    return res.status(400).json({ error: 'Query parameter "title" is required.' });
  }

  try {
    const { getFormattedCatalogLinks } = await import('../utils/catalog-store.js');
    const result = await getFormattedCatalogLinks(title, { sourceUrl: req.query.url });
    return res.json(result);
  } catch (err) {
    logger.error(`Error fetching title links: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/catalog/custom
 * Appends custom titles to the dataset container.
 */
router.post('/catalog/custom', async (req, res) => {
  const { titles, platform } = req.body;
  if (!Array.isArray(titles) || titles.length === 0) {
    return res.status(400).json({ error: 'Array of "titles" is required.' });
  }

  try {
    const fs = await import('fs');
    const path = await import('path');
    const catalogPath = path.resolve('src/data/tv-dataset.json');
    let items = [];
    if (fs.existsSync(catalogPath)) {
      items = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    }

    let addedCount = 0;
    for (const rawTitle of titles) {
      const t = String(rawTitle).trim();
      if (!t) continue;
      if (!items.some((i) => i.title.toLowerCase() === t.toLowerCase())) {
        items.push({
          rank: items.length + 1,
          title: t,
          format: 'Custom Series',
          genre: 'User Added',
          country: 'Global',
          language: 'Multi',
          platform: platform || 'Custom',
        });
        addedCount++;
      }
    }

    fs.writeFileSync(catalogPath, JSON.stringify(items, null, 2), 'utf8');
    return res.json({ success: true, addedCount, totalTitles: items.length });
  } catch (err) {
    logger.error(`Error adding custom catalog titles: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/crawler/status
 * Retrieves live status of the full site crawler.
 */
router.get('/crawler/status', async (req, res) => {
  try {
    const { siteCrawler } = await import('../crawler/site-crawler.js');
    return res.json(siteCrawler.getStatus());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/crawler/start
 * Starts crawling 4KHDHub by page range or continuously.
 */
router.post('/crawler/start', async (req, res) => {
  try {
    const { siteCrawler } = await import('../crawler/site-crawler.js');
    const result = await siteCrawler.start(req.body || {});
    return res.json(result);
  } catch (err) {
    logger.error(`Failed to start crawler: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/crawler/pause
 * Pauses active crawl.
 */
router.post('/crawler/pause', async (req, res) => {
  try {
    const { siteCrawler } = await import('../crawler/site-crawler.js');
    return res.json(siteCrawler.pause());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/crawler/resume
 * Resumes paused crawl.
 */
router.post('/crawler/resume', async (req, res) => {
  try {
    const { siteCrawler } = await import('../crawler/site-crawler.js');
    return res.json(siteCrawler.resume());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/crawler/stop
 * Terminates active crawl.
 */
router.post('/crawler/stop', async (req, res) => {
  try {
    const { siteCrawler } = await import('../crawler/site-crawler.js');
    return res.json(siteCrawler.stop());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/reset
 * Resets / clears all scraped records and jobs so old scraping data is removed.
 */
router.post('/reset', async (req, res) => {
  try {
    jobQueue.cancelAll();
    const deletedLinks = await scrapedLinksRepo.clear();
    const deletedJobs = await jobsRepo.clear();
    logger.database(`Reset database: cleared ${deletedLinks.deletedCount || 0} links and ${deletedJobs.deletedCount || 0} jobs`);
    return res.json({
      success: true,
      message: 'All scraped records and jobs have been reset.',
      deletedLinks: deletedLinks.deletedCount || 0,
      deletedJobs: deletedJobs.deletedCount || 0,
    });
  } catch (err) {
    logger.error(`Error resetting database: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/jobs/:id
 * Retrieves the status and details of a scrape job.
 */
router.get('/jobs/:id', async (req, res) => {
  try {
    const job = await jobsRepo.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: `Job with ID '${req.params.id}' not found.` });
    }
    return res.json(job);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/jobs
 * Lists recent scrape jobs.
 */
router.get('/jobs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const jobs = await jobsRepo.listJobs({}, limit);
    return res.json(jobs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/stats
 * Dashboard metrics summary.
 */
router.get('/stats', async (req, res) => {
  try {
    const jobStats = await jobsRepo.getStats();
    const totalLinks = await scrapedLinksRepo.count();
    const resolvedLinks = await scrapedLinksRepo.count({ status: 'RESOLVED' });
    const challengeLinks = await scrapedLinksRepo.count({ status: 'HUMAN_VERIFICATION_REQUIRED' });
    const errorLinks = await scrapedLinksRepo.count({
      status: { $in: ['ERROR', 'ACCESS_DENIED', 'TIMEOUT', 'REDIRECT_LIMIT_EXCEEDED'] },
    });

    return res.json({
      total: jobStats.total,
      totalLinks,
      resolved: resolvedLinks,
      partial: jobStats.partial,
      humanVerification: challengeLinks,
      errors: errorLinks + jobStats.errors,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/links
 * Lists scraped link records with optional filtering.
 */
router.get('/links', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const query = {};
    if (req.query.status) {
      query.status = req.query.status;
    }
    if (req.query.provider) {
      query.provider = req.query.provider;
    }
    if (req.query.quality && req.query.quality !== 'all') {
      const q = req.query.quality.trim().replace(/p$/i, '');
      query.quality = { $regex: new RegExp(`^${q}`, 'i') };
    }
    if (req.query.scope && req.query.scope !== 'all') {
      query.scope = req.query.scope.toLowerCase();
    }
    if (req.query.season && req.query.season !== 'all') {
      query.season = parseInt(req.query.season, 10);
    }

    if (req.query.sourceUrl) {
      const sUrl = req.query.sourceUrl.trim();
      const withoutSlash = sUrl.replace(/\/+$/, '');
      const withSlash = withoutSlash + '/';
      query.sourceUrl = { $in: [withoutSlash, withSlash] };
    }
    if (req.query.mediatorUrl) {
      query.mediatorUrl = req.query.mediatorUrl.trim();
    }
    if (req.query.titleSearch) {
      const term = req.query.titleSearch.trim();
      const safeRegex = new RegExp(term.replace(/[.*+?^\$\{\}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { normalizedTitle: safeRegex },
        { title: safeRegex },
        { filename: safeRegex },
      ];
    }

    const queryStart = Date.now();
    let links = await scrapedLinksRepo.find(query, {
      sort: { createdAt: -1 },
      limit,
    });
    logger.log('TIMING', `[catalogue-query] filter=${JSON.stringify(Object.keys(query))} limit=${limit} results=${links.length} took=${Date.now() - queryStart}ms`);

    // Exclude intermediate mediator URLs, DotFlix, and HubDrive links (only genuine HubCloud)
    links = links.filter((l) =>
      !(l.providerUrl && l.providerUrl.includes('greenmotors')) &&
      !/dtflix|dotflix/i.test(l.providerUrl || '') &&
      !/hubdrive/i.test(l.provider || '') &&
      !/hubdrive/i.test(l.providerUrl || '') &&
      !/hubdrive/i.test(l.mediatorUrl || '')
    );

    return res.json(links);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/links/lookup-title?mediatorUrl=<url>&providerUrl=<url>
 * Lightweight targeted title lookup for Go bot — avoids full catalogue fetch.
 */
router.get('/links/lookup-title', async (req, res) => {
  try {
    const { mediatorUrl: mu, providerUrl: pu } = req.query;
    if (!mu && !pu) {
      return res.status(400).json({ error: 'mediatorUrl or providerUrl is required.' });
    }
    const lookupStart = Date.now();
    let link = null;
    if (mu) {
      const found = await scrapedLinksRepo.find({ mediatorUrl: mu.trim() }, { limit: 1 });
      if (found && found.length > 0) link = found[0];
    }
    if (!link && pu) {
      const found = await scrapedLinksRepo.find({ providerUrl: pu.trim() }, { limit: 1 });
      if (found && found.length > 0) link = found[0];
    }
    logger.log('TIMING', `[lookup-title] took=${Date.now() - lookupStart}ms hit=${!!link}`);
    if (!link) return res.json({ title: '', filename: '' });
    return res.json({
      title: link.title || '',
      filename: link.filename || '',
      sizeDisplay: link.sizeDisplay || '',
      quality: link.quality || '',
      scope: link.scope || '',
      season: link.season || 0,
      episode: link.episode || 0,
      sourceUrl: link.sourceUrl || ''
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/links/:id
 * Retrieves a single complete scraped link record.
 */
router.get('/links/:id', async (req, res) => {
  try {
    const link = await scrapedLinksRepo.findById(req.params.id);
    if (!link) {
      return res.status(404).json({ error: `Record with ID '${req.params.id}' not found.` });
    }
    return res.json(link);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/links/:id
 * Deletes a single scraped link record.
 */
router.delete('/links/:id', async (req, res) => {
  try {
    const result = await scrapedLinksRepo.clear({ _id: req.params.id });
    return res.json({ success: true, deletedCount: result.deletedCount || 0 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/links/batch
 * Saves or updates a batch of scraped link records.
 */
router.post('/links/batch', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Field "items" must be an array.' });
    }
    const saved = [];
    for (const item of items) {
      const rec = await scrapedLinksRepo.saveLink(item);
      saved.push(rec);
    }
    return res.json({ success: true, count: saved.length, records: saved });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/parse-html
 * Parses raw HTML provided by the user and saves extracted records.
 */
router.post('/parse-html', async (req, res) => {
  const { html, sourceUrl = 'https://source-pasted.local/', quality = 'all', scope = 'all', reset, autoReset } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Field "html" is required.' });
  }

  try {
    const isDestinationResolution =
      html.includes('hubcloud') ||
      html.includes('gdlink') ||
      html.includes('/file/') ||
      html.includes('countdown-number') ||
      html.includes('success-section') ||
      html.includes('continue-btn');

    if ((reset || autoReset) && !isDestinationResolution) {
      if (sourceUrl) {
        await scrapedLinksRepo.clear({ sourceUrl: sourceUrl.trim() });
        await jobsRepo.clear({ url: sourceUrl.trim() });
      }
      logger.database('Reset completed for direct HTML input session.');
    }

    // Check if pasted HTML or text contains direct HubCloud destination links
    // (e.g. from countdown pages or direct link pastes)
    const { isHubCloudDriveUrl, extractHubCloudDriveId, fetchHubCloudMetadata } = await import('../providers/hubcloud/validator.js');
    const { loadRawCatalog } = await import('../utils/catalog-store.js');

    const candidateUrls = new Set();
    const packMetaMap = new Map();

    const packJsonMatch = html.match(/packData\s*=\s*JSON\.parse\(`([^`]+)`\)/);
    if (packJsonMatch) {
      try {
        const parsedPack = JSON.parse(packJsonMatch[1]);
        let domain = 'hubcloud.ist';
        if (sourceUrl && isHubCloudDriveUrl(sourceUrl)) {
          domain = new URL(sourceUrl).hostname;
        } else {
          const matchedDomain = html.match(/(?:https?:\/\/)?([a-z0-9-]+\.hubcloud\.[a-z]{2,}|hubcloud\.[a-z]{2,})/i);
          if (matchedDomain) {
            domain = matchedDomain[1];
          }
        }
        if (parsedPack.pack?.slug) {
          const packUrl = `https://${domain}/drive/packs/${parsedPack.pack.slug}`;
          candidateUrls.add(packUrl);
          packMetaMap.set(packUrl, {
            filename: parsedPack.pack.pack_name,
            isPack: true,
            scope: 'pack',
          });
        }
        if (Array.isArray(parsedPack.files)) {
          for (const f of parsedPack.files) {
            if (f.share_id) {
              const fileUrl = `https://${domain}/drive/${f.share_id}`;
              candidateUrls.add(fileUrl);
              packMetaMap.set(fileUrl, {
                filename: f.file_name,
                isPack: false,
                scope: 'episode',
                sizeBytes: f.file_size,
                sizeDisplay: f.file_size ? `${(f.file_size / (1024 * 1024 * 1024)).toFixed(2)} GB` : null,
              });
            }
          }
        }
      } catch {}
    }

    const textUrls = html.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*hubcloud\.[a-z]{2,}\/drive\/[^\s"'<>]+/gi) || [];
    for (const u of textUrls) candidateUrls.add(u.trim());

    try {
      const cheerio = await import('cheerio');
      const $ = cheerio.load(html);
      $('#link, .continue-btn, a[href*="/drive/"], a[href*="hubcloud"], a[href*="gdlink"], a[href*="/file/"]').each((_, el) => {
        const h = $(el).attr('href');
        if (h && /^https?:\/\//i.test(h)) candidateUrls.add(h.trim());
      });
    } catch {}

    const resolvedCandidates = [...candidateUrls].filter((u) => isHubCloudDriveUrl(u));

    if (resolvedCandidates.length > 0) {
      const savedRecords = [];
      const formattedLines = [];

      for (const destinationUrl of resolvedCandidates) {
        const provider = 'HubCloud';
        const fileId = extractHubCloudDriveId(destinationUrl);

        // Check if an existing record in the database matches this mediator URL or needs this pack/episode
        let targetRecord = null;
        if (sourceUrl && sourceUrl.startsWith('http') && !sourceUrl.includes('source-pasted.local')) {
          const found = await scrapedLinksRepo.find({ mediatorUrl: sourceUrl });
          if (found && found.length > 0) targetRecord = found[0];
        }

        if (!targetRecord) {
          const isPack = destinationUrl.includes('/packs/') || /pack/i.test(html);
          const allLinks = await scrapedLinksRepo.find({});
          // Find first pending record that doesn't have a final providerUrl yet or has a placeholder mediatorUrl
          const pending = allLinks.filter((l) => {
            const hasFinal = l.providerUrl && isHubCloudDriveUrl(l.providerUrl);
            if (hasFinal) return false;
            if (savedRecords.some((s) => s._id === l._id)) return false;
            return isPack ? (l.scope === 'pack') : (l.scope === 'episode' || l.scope === 'movie');
          });
          if (pending.length > 0) {
            targetRecord = pending[0];
          }
        }

        let filename = null;
        let itemScope = targetRecord?.scope || (destinationUrl.includes('/packs/') ? 'pack' : 'movie');
        let itemSizeDisplay = targetRecord?.sizeDisplay || null;
        let itemSizeBytes = targetRecord?.sizeBytes || 0;

        if (packMetaMap.has(destinationUrl)) {
          const pm = packMetaMap.get(destinationUrl);
          if (pm.filename) filename = pm.filename;
          if (pm.scope) itemScope = pm.scope;
          if (pm.sizeDisplay) itemSizeDisplay = pm.sizeDisplay;
          if (pm.sizeBytes) itemSizeBytes = pm.sizeBytes;
        }

        try {
          if (!filename && provider === 'HUBCLOUD') {
            const meta = await fetchHubCloudMetadata(destinationUrl, { maxRetries: 0, timeout: 3000 });
            if (meta?.filename) filename = meta.filename;
          }
        } catch {}

        if (!filename && targetRecord) {
          filename = targetRecord.filename || targetRecord.title;
        }

        if (!filename) {
          const lastCatalog = loadRawCatalog().slice(-1)[0];
          let pageTitle = 'Release';
          try {
            const cheerio = await import('cheerio');
            pageTitle = cheerio.load(html)('title').text().replace(/\s*-\s*Download.*$/i, '').trim() || 'Release';
          } catch {}
          const baseName = lastCatalog?.title || pageTitle || 'Release';
          const isPack = destinationUrl.includes('/packs/') || /pack/i.test(html);
          filename = isPack ? `${baseName.replace(/\s+/g, '.')}.Complete.Pack.Zip` : `${baseName.replace(/\s+/g, '.')}.mkv`;
        }

        const recordToSave = {
          sourceUrl: targetRecord?.sourceUrl || sourceUrl || destinationUrl,
          sourceDomain: destinationUrl ? new URL(destinationUrl).hostname : 'hubcloud.foo',
          title: filename,
          scope: itemScope,
          season: targetRecord?.season || 1,
          episode: targetRecord?.episode || null,
          quality: targetRecord?.quality || 'all',
          codec: targetRecord?.codec || null,
          sizeDisplay: itemSizeDisplay,
          sizeBytes: itemSizeBytes,
          provider,
          providerUrl: destinationUrl,
          fileId,
          directDownloadUrl: destinationUrl,
          mediatorUrl: (savedRecords.length === 0 && targetRecord?.mediatorUrl) ? targetRecord.mediatorUrl : destinationUrl,
          filename,
          status: 'RESOLVED',
        };

        if (targetRecord?._id && savedRecords.length === 0) {
          recordToSave._id = targetRecord._id;
        }

        const savedRecord = await scrapedLinksRepo.saveLink(recordToSave);
        savedRecords.push(savedRecord);

        const formattedLine = `Name : ${filename} ${provider} = ${destinationUrl}`;
        formattedLines.push(formattedLine);
        logger.discovered(`[mediator/parse-html] Resolved destination: ${formattedLine}`);
      }

      return res.json({
        success: true,
        count: savedRecords.length,
        records: savedRecords,
        formatted: formattedLines.join('\n'),
        formattedLines,
        activeScope: scope,
        activeQuality: quality,
      });
    }

    // Process pasted HTML as 4KHub4U / 4KHDHub
    const { parse4KHubCatalogue, resolveCatalogueLinks } = await import('../scrapers/4khub4u/catalogue.js');
    const { recordInCatalog } = await import('../utils/catalog-store.js');

      const rawCatalogue = parse4KHubCatalogue(html, sourceUrl || 'https://4khdhub.one/');
      const catalogue = await resolveCatalogueLinks(rawCatalogue, { concurrency: 20, timeout: 4500 }).catch(() => rawCatalogue);
      const isMoviePage = catalogue.type === 'movie';

      recordInCatalog({
        title: catalogue.title || '4KHub4U Content',
        url: sourceUrl || 'https://4khdhub.one/',
        format: isMoviePage ? 'Movie' : 'Series',
        platform: '4KHub4U',
      });

      const allReleases =
        catalogue.type === 'series' && Array.isArray(catalogue.seasons)
          ? catalogue.seasons.flatMap((s) => s.releases || [])
          : Array.isArray(catalogue.qualities)
          ? catalogue.qualities.flatMap((q) => q.releases || [])
          : [];

      const savedRecords = [];
      for (const rel of allReleases) {
        for (const dl of (rel.downloadLinks || [])) {
          const rawLink = dl.url;
          // STRICT FILTER: HubDrive links are prohibited; only HubCloud links are preserved
          if (!rawLink || /hubdrive/i.test(dl.provider || '') || /hubdrive/i.test(rawLink)) {
            continue;
          }
          const isDirect = dl.isDirectDestination || isHubCloudDriveUrl(rawLink) || /hubcloud\.[a-z0-9.]+/i.test(rawLink);
          const providerUrl = isDirect ? rawLink : null;
          const mediatorUrl = isDirect ? null : rawLink;
          const fileId = isDirect ? (extractHubCloudDriveId(rawLink) || rawLink.split('/').pop()) : null;
          const status = isDirect ? 'RESOLVED' : 'DISCOVERED';

          const doc = {
            sourceUrl: sourceUrl || 'https://4khdhub.one/',
            sourceDomain: sourceUrl && sourceUrl.startsWith('http') ? new URL(sourceUrl).hostname : '4khdhub.one',
            title: rel.label || catalogue.title,
            filename: rel.filename || rel.label || catalogue.title,
            scope: rel.scope || (isMoviePage ? 'movie' : (rel.episode !== null && rel.episode !== undefined ? 'episode' : 'pack')),
            season: isMoviePage ? null : (rel.season ?? 1),
            episode: isMoviePage ? null : (rel.episode ?? null),
            quality: rel.quality?.normalized || rel.resolution || 'unknown',
            codec: rel.codec || null,
            sizeDisplay: rel.fileSize || null,
            provider: 'HubCloud',
            providerUrl,
            mediatorUrl,
            fileId,
            status,
          };

          const saved = await scrapedLinksRepo.saveLink(doc);
          savedRecords.push(saved);
        }
      }

      return res.json({
        success: true,
        count: savedRecords.length,
        records: savedRecords,
        activeScope: isMoviePage ? 'movie' : scope,
        activeQuality: quality,
      });
  } catch (err) {
    logger.error(`Error parsing direct HTML: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/resolve-link
 * Resolves an individual mediator link (or HubCloud link) via Playwright browser flow.
 */
router.post('/resolve-link', async (req, res) => {
  const resolverAbort = new AbortController();
  let releaseResolverSlot = null;
  res.once('close', () => {
    if (!res.writableEnded) {
      resolverAbort.abort(new Error('Resolver client disconnected'));
    }
  });
  const { signal } = resolverAbort;
  const { id, mediatorUrl } = req.body;
  try {
    let link = null;
    if (id) {
      link = await scrapedLinksRepo.findById(id);
    }

    const urlToResolve = mediatorUrl || link?.mediatorUrl || link?.providerUrl;
    if (!urlToResolve) {
      return res.status(400).json({ error: 'Either link id or mediatorUrl is required.' });
    }

    if (!link && urlToResolve) {
      const allMatches = await scrapedLinksRepo.find({ mediatorUrl: urlToResolve });
      if (allMatches && allMatches.length > 0) {
        link = allMatches[0];
      }
    }



    const { extractHubCloudDriveId, fetchHubCloudMetadata } = await import('../providers/hubcloud/validator.js');

    // FAST-PATH: If this link was already resolved by background pre-resolver or prior query, return immediately!
    if (link && link.status === 'RESOLVED' && link.providerUrl && /hubcloud\.[a-z0-9.]+/i.test(link.providerUrl)) {
      return res.json({
        success: true,
        destination: link.providerUrl,
        driveId: link.fileId || extractHubCloudDriveId(link.providerUrl),
        state: 'CACHED_RESOLVED',
        title: link.filename || link.title || '',
      });
    }

    const isXDMoviesMediator = /link\.xdmovies\.[a-z0-9.]+|latestnewsonline\.[a-z0-9.]+|xdmovies\.[a-z0-9.]+\/download/i.test(urlToResolve);
    let resolution;

    if (isXDMoviesMediator) {
      const { resolveXDMoviesMediator } = await import('../scrapers/xdmovies/mediator.js');
      resolution = await resolveXDMoviesMediator(urlToResolve, {
        signal,
        timeoutMs: 125000,
      });
    } else {
      const { resolveMediatorHttpFirst } = await import('../resolvers/mediator/http-first.js');
      releaseResolverSlot = await mediatorResolutionSemaphore.acquire(signal);
      if (signal.aborted || res.destroyed) return;
      resolution = await resolveMediatorHttpFirst(urlToResolve, {
        meta: link || {},
        countdownTimeout: 35000,
        navigationTimeout: 20000,
      });
    }
    if (signal.aborted || res.destroyed) return;

    // STRICT FILTER: Discard any HubDrive destination
    if (resolution.success && resolution.destination && /hubdrive/i.test(resolution.destination)) {
      return res.status(400).json({
        success: false,
        error: 'HubDrive link resolved, but only direct HubCloud is supported.',
      });
    }

    if (resolution.success && resolution.destination) {
      // Return resolved destination immediately to Telegram bot / caller
      const driveId = extractHubCloudDriveId(resolution.destination);
      const earlyTitle = resolution.metadata?.title || resolution.meta?.filename || resolution.meta?.title || link?.filename || link?.title || '';
      res.json({
        success: true,
        destination: resolution.destination,
        driveId,
        state: resolution.state || 'RESOLVED',
        title: earlyTitle,
      });

      // Background: enrich metadata and save to DB without blocking caller
      setImmediate(async () => {
        const metaStart = Date.now();
        try {
          let finalTitle = earlyTitle;
          if (!finalTitle || finalTitle === 'Unknown Title') {
            const hubMeta = await fetchHubCloudMetadata(resolution.destination).catch(() => null);
            if (hubMeta?.filename) {
              finalTitle = hubMeta.filename;
            }
          }
          logger.log('TIMING', `[metadata enrichment] destination=${resolution.destination} took=${Date.now() - metaStart}ms title="${finalTitle}"`);

          if (link) {
            link.providerUrl = resolution.destination;
            link.fileId = driveId;
            link.status = 'RESOLVED';
            if (finalTitle) {
              link.filename = finalTitle;
              link.title = finalTitle;
            }
            await scrapedLinksRepo.saveLink(link);
          } else {
            const autoDoc = {
              sourceUrl: urlToResolve,
              sourceDomain: '4khdhub.one',
              title: finalTitle || 'Movie Release',
              filename: finalTitle || '',
              scope: 'movie',
              provider: 'HUBCLOUD',
              providerUrl: resolution.destination,
              mediatorUrl: urlToResolve,
              fileId: driveId,
              status: 'RESOLVED',
            };
            await scrapedLinksRepo.saveLink(autoDoc).catch(() => {});
          }
        } catch (bgErr) {
          logger.error(`[resolve-link BG] enrichment error: ${bgErr.message}`);
        }
      });
      return;
    } else {
      if (link) {
        link.status = resolution.state === 'CAPTCHA_REQUIRED' ? 'HUMAN_VERIFICATION_REQUIRED' : 'ERROR';
        link.error = resolution.error || 'Failed to resolve mediator link';
        await scrapedLinksRepo.saveLink(link);
      }
      return res.status(400).json({
        success: false,
        isDead: resolution.isDead || false,
        state: resolution.state,
        error: resolution.error || 'Failed to resolve mediator link',
      });
    }
  } catch (err) {
    if (signal.aborted || res.destroyed) return;
    logger.error(`Error resolving link: ${err.message}`);
    return res.status(500).json({ error: err.message });
  } finally {
    releaseResolverSlot?.();
  }
});

export default router;
