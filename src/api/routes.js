import express from 'express';
import { validateUrl, normalizeNexdriveUrl } from '../utils/url.js';
import { jobQueue } from '../queue/job-queue.js';
import { jobsRepo, scrapedLinksRepo } from '../database/models.js';
import { logger } from '../logging/logger.js';
import { matchesQuality } from '../utils/normalize.js';
import { runBoundedWithBrowser } from '../utils/concurrency.js';
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
        // 2. Search 4KHDHub
        const { search4KHDHub } = await import('../providers/4khdhub/search.js');
        const hubResult = await search4KHDHub(trimmedInput).catch(() => null);

        let chosenResult = null;
        let chosenPlatform = '';

        if (hubResult?.success && hubResult?.bestMatch) {
          chosenResult = hubResult.bestMatch;
          chosenPlatform = '4KHDHub';
        }

        if (!chosenResult) {
          return res.status(404).json({
            error: `No movie or series found on 4KHDHub for title: "${trimmedInput}". Please enter a valid URL or try another title.`,
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
      await scrapedLinksRepo.clear();
      await jobsRepo.clear();
      logger.database('Auto-reset completed before enqueuing new scrape job.');
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
 * GET /api/search?q=<query>
 * Searches 4KHDHub for matching movie or series titles.
 */
router.get('/search', async (req, res) => {
  const query = (req.query.q || req.query.query || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required.' });
  }

  try {
    const { search4KHDHub } = await import('../providers/4khdhub/search.js');
    const hubRes = await search4KHDHub(query).catch(() => null);

    const results = [];
    if (hubRes?.results) {
      results.push(...hubRes.results.map((r) => ({ ...r, provider: '4KHDHub' })));
    }

    const bestMatch = (hubRes?.bestMatch)
      ? { ...hubRes.bestMatch, provider: '4KHDHub' }
      : results[0] || null;

    return res.json({
      success: true,
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

    let links = await scrapedLinksRepo.find(query, {
      sort: { createdAt: -1 },
      limit,
    });

    // Exclude intermediate mediator URLs and DotFlix (only genuine GDFLIX/HubCloud)
    links = links.filter((l) => !(l.providerUrl && l.providerUrl.includes('greenmotors')) && !/dtflix|dotflix/i.test(l.providerUrl || ''));

    return res.json(links);
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
      await scrapedLinksRepo.clear();
      await jobsRepo.clear();
      logger.database('Auto-reset completed before parsing direct HTML.');
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

    const textUrls = html.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:hubcloud\.[a-z]{2,}\/drive\/|gdlink\.[a-z]{2,}\/file\/|cloudmoviez\.[a-z]{2,}\/file\/)[^\s"'<>]+/gi) || [];
    for (const u of textUrls) candidateUrls.add(u.trim());

    try {
      const cheerio = await import('cheerio');
      const $ = cheerio.load(html);
      $('#link, .continue-btn, a[href*="/drive/"], a[href*="hubcloud"], a[href*="gdlink"], a[href*="/file/"]').each((_, el) => {
        const h = $(el).attr('href');
        if (h && /^https?:\/\//i.test(h)) candidateUrls.add(h.trim());
      });
    } catch {}

    const resolvedCandidates = [...candidateUrls].filter((u) => (
      isHubCloudDriveUrl(u) ||
      /gdlink\.[a-z]{2,}\/file\/([a-zA-Z0-9_-]+)/i.test(u) ||
      /cloudmoviez\.[a-z]{2,}\/file\/([a-zA-Z0-9_-]+)/i.test(u)
    ));

    if (resolvedCandidates.length > 0) {
      const savedRecords = [];
      const formattedLines = [];

      for (const destinationUrl of resolvedCandidates) {
        let provider = 'HUBCLOUD';
        let fileId = null;

        if (isHubCloudDriveUrl(destinationUrl)) {
          provider = 'HUBCLOUD';
          fileId = extractHubCloudDriveId(destinationUrl);
        } else if (/gdlink\.[a-z]{2,}\/file\/([a-zA-Z0-9_-]+)/i.test(destinationUrl) || /cloudmoviez\.[a-z]{2,}\/file\/([a-zA-Z0-9_-]+)/i.test(destinationUrl)) {
          provider = 'GDFLIX';
          const match = /(?:gdlink|cloudmoviez)\.[a-z]{2,}\/file\/([a-zA-Z0-9_-]+)/i.exec(destinationUrl);
          fileId = match ? match[1] : null;
        }

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
            const hasFinal = l.providerUrl && (
              isHubCloudDriveUrl(l.providerUrl) ||
              l.providerUrl.includes('gdlink.dev/file/') ||
              l.providerUrl.includes('cloudmoviez.shop/file/')
            );
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

    // Check if pasted HTML / URL is from CloudMoviez
    const isCloudMoviez = /cloudmoviez/i.test(sourceUrl) || /cloudmoviez/i.test(html) || html.includes('cmz-row-card') || html.includes('cmz-accordion');
    if (isCloudMoviez) {
      const canonicalMatch = /<link[^>]+rel=['"]canonical['"][^>]+href=['"]([^'"]+)['"]/i.exec(html)?.[1];
      const effectiveUrl = (sourceUrl && /cloudmoviez/i.test(sourceUrl) && !sourceUrl.includes('.jpg'))
        ? sourceUrl
        : (canonicalMatch || /https?:\/\/[^\s"'<>]*(?:cloudmoviez\.shop|cloudmoviez\.top)[^\s"'<>]*/i.exec(html)?.[0] || 'https://c1.cloudmoviez.shop/');

      const { extractCloudMoviezLinks } = await import('../providers/cloudmoviez/extractor.js');
      const extracted = extractCloudMoviezLinks(html, effectiveUrl, {
        targetQuality: quality,
        targetScope: scope,
      });
      const allExtractedLinks = extracted.allLinks || extracted.links;

      const savedRecords = [];
      for (const item of allExtractedLinks) {
        const rec = {
          sourceUrl: item.sourceUrl,
          sourceDomain: 'c1.cloudmoviez.shop',
          title: item.filename || item.title,
          scope: item.scope,
          season: item.season,
          episode: item.episode,
          quality: item.quality,
          codec: item.codec,
          sizeDisplay: item.sizeDisplay,
          provider: item.provider || 'GDFLIX',
          providerUrl: item.providerUrl,
          mediatorUrl: item.mediatorUrl,
          filename: item.filename || item.title,
          status: 'RESOLVED',
        };
        const saved = await scrapedLinksRepo.saveLink(rec);
        savedRecords.push(saved);
      }

      logger.discovered(`[CloudMoviez/parse-html] Processed and saved ${savedRecords.length} release(s) for "${extracted.title}"`);
      const { recordInCatalog } = await import('../utils/catalog-store.js');
      recordInCatalog({
        title: extracted.cleanTitle || extracted.title,
        url: effectiveUrl,
        format: extracted.contentType === 'series' ? 'Series' : 'Movie',
        genre: extracted.genre || 'Drama, Comedy',
        country: 'India',
        language: 'Hindi',
        platform: 'CloudMoviez',
      });

      return res.json({
        success: true,
        count: savedRecords.length,
        records: savedRecords,
        activeScope: scope,
        activeQuality: quality,
      });
    }

    // Check if pasted HTML / URL is from UNiTYhub
    const isUnityHub = /unityhub/i.test(sourceUrl) || /unityhub/i.test(html);
    if (isUnityHub) {
      const effectiveUrl = (sourceUrl && /unityhub/i.test(sourceUrl)) ? sourceUrl : (/https?:\/\/[^\s]+unityhub[^\s]*/i.exec(html)?.[0] || sourceUrl);
      const { extractUnityHubLinks } = await import('../providers/unityhub/extractor.js');
      const extracted = await extractUnityHubLinks(html, effectiveUrl, {
        targetQuality: quality,
        targetScope: scope,
      });
      const allExtractedLinks = extracted.allLinks || extracted.links;

      const savedRecords = [];
      for (const item of allExtractedLinks) {
        const rec = {
          sourceUrl: item.sourceUrl,
          sourceDomain: 'www.unityhub.buzz',
          title: item.filename || item.title,
          scope: item.scope,
          season: item.season,
          episode: item.episode,
          quality: item.quality,
          codec: item.codec,
          sizeDisplay: item.sizeDisplay,
          provider: item.provider || 'UNKNOWN',
          providerUrl: item.providerUrl,
          mediatorUrl: null,
          filename: item.filename || item.title,
          status: 'RESOLVED',
        };
        const saved = await scrapedLinksRepo.saveLink(rec);
        savedRecords.push(saved);
      }

      return res.json({
        success: true,
        count: savedRecords.length,
        records: savedRecords,
        activeScope: scope,
        activeQuality: quality,
      });
    }

    // Check if pasted HTML / URL is from XDMovies
    const isXDMoviesHtml = /xdmovies/i.test(sourceUrl) || /xdmovies/i.test(html) || html.includes('download-item') || html.includes('pack-card') || html.includes('episode-card');
    if (isXDMoviesHtml) {
      const { parseXDMoviesCatalogue } = await import('../scrapers/xdmovies/catalogue.js');
      const { resolveXDMoviesMediator } = await import('../scrapers/xdmovies/mediator.js');
      const { extractHubCloudDriveId, isHubCloudDriveUrl, fetchHubCloudMetadata } = await import('../providers/hubcloud/validator.js');
      const { recordInCatalog } = await import('../utils/catalog-store.js');
      const { matchesQuality } = await import('../utils/normalize.js');

      const effectiveUrl = (sourceUrl && /xdmovies/i.test(sourceUrl))
        ? sourceUrl
        : (/https?:\/\/[^\s"'<>]*(?:xdmovies\.[a-z0-9.]+|xdmoviez\.[a-z0-9.]+)[^\s"'<>]*/i.exec(html)?.[0] || 'https://huh.xdmovies.wtf/');

      const catalogue = parseXDMoviesCatalogue(html, effectiveUrl);
      const isMoviePage = catalogue.type === 'movie';

      // Flatten releases
      const allExtractedLinks = [];
      if (catalogue && catalogue.qualities) {
        for (const q of catalogue.qualities) {
          for (const rel of q.releases) {
            for (const dl of (rel.downloadLinks || [])) {
              allExtractedLinks.push({
                title: rel.label || catalogue.title,
                scope: rel.scope || (isMoviePage ? 'movie' : 'episode'),
                season: isMoviePage ? null : (rel.season ?? 1),
                episode: isMoviePage ? null : (rel.episode ?? null),
                quality: rel.quality?.normalized || rel.resolution || 'unknown',
                codec: rel.codec,
                sizeDisplay: rel.fileSize,
                mediatorUrl: dl.url,
                provider: 'HUBCLOUD',
              });
            }
          }
        }
      }

      // Check if search / catalog listing page
      if (allExtractedLinks.length === 0) {
        const cheerio = await import('cheerio');
        const $ = cheerio.load(html);
        const postUrls = [];
        $('a[href]').each((_, el) => {
          let href = $(el).attr('href') || '';
          if (href && /\/(?:movies|series)\/[a-z0-9-]+/i.test(href) && !/\/category\/|\/page\/|\/tag\//i.test(href)) {
            const fullUrl = href.startsWith('http') ? href : new URL(href, effectiveUrl).href;
            if (!postUrls.includes(fullUrl)) postUrls.push(fullUrl);
          }
        });
        if (postUrls.length > 0) {
          logger.discovered(`[XDMovies/parse-html] Search/catalog page detected with ${postUrls.length} post(s)`);
          for (const pUrl of postUrls) {
            await jobQueue.addJob(pUrl, { quality, scope });
          }
          return res.json({
            success: true,
            isSearchPage: true,
            postCount: postUrls.length,
            posts: postUrls,
            message: `Found ${postUrls.length} posts in XDMovies page, enqueued for scraping.`,
          });
        }
      }

      recordInCatalog({
        title: catalogue.title || 'XDMovies Content',
        url: effectiveUrl,
        format: isMoviePage ? 'Movie' : 'Series',
        platform: 'XDMovies',
      });

      const savedRecords = [];
      for (const item of allExtractedLinks) {
        const rec = {
          sourceUrl: effectiveUrl,
          sourceDomain: new URL(effectiveUrl).hostname,
          title: item.title,
          scope: item.scope,
          season: item.season,
          episode: item.episode,
          quality: item.quality,
          codec: item.codec,
          sizeDisplay: item.sizeDisplay,
          provider: 'HUBCLOUD',
          mediatorUrl: item.mediatorUrl,
          filename: item.title,
          status: 'DISCOVERED',
        };
        const saved = await scrapedLinksRepo.saveLink(rec);
        savedRecords.push(saved);
      }

      // Select candidate(s) to resolve based on quality and scope
      let toResolve = [...allExtractedLinks];
      if (quality && quality !== 'all') {
        const filtered = toResolve.filter((l) => matchesQuality(l.quality, quality));
        if (filtered.length > 0) toResolve = filtered;
      }
      if (scope && scope !== 'all') {
        if (isMoviePage) {
          const filtered = toResolve.filter((l) => l.scope === 'movie');
          if (filtered.length > 0) toResolve = filtered;
        } else {
          const filtered = toResolve.filter((l) => l.scope === scope);
          if (filtered.length > 0) toResolve = filtered;
        }
      }

      logger.discovered(`[XDMovies/parse-html] Processed and saved ${savedRecords.length} release(s) for "${catalogue.title}". Resolving top candidates in background...`);

      // Fire-and-forget background resolution for top matching candidates
      (async () => {
        try {
          const topCandidates = toResolve.slice(0, 2);
          for (const cand of topCandidates) {
            const medRes = await resolveXDMoviesMediator(cand.mediatorUrl, { headless: false });
            if (medRes.success && medRes.destination && isHubCloudDriveUrl(medRes.destination)) {
              let finalTitle = medRes.metadata?.filename || medRes.metadata?.title || cand.title;
              if (!finalTitle || finalTitle === 'Unknown Title') {
                const hubMeta = await fetchHubCloudMetadata(medRes.destination);
                if (hubMeta?.filename) finalTitle = hubMeta.filename;
              }
              await scrapedLinksRepo.saveLink({
                sourceUrl: effectiveUrl,
                sourceDomain: new URL(effectiveUrl).hostname,
                title: finalTitle,
                scope: cand.scope,
                season: cand.season,
                episode: cand.episode,
                quality: cand.quality,
                codec: cand.codec,
                sizeDisplay: cand.sizeDisplay,
                provider: 'HUBCLOUD',
                providerUrl: medRes.destination,
                mediatorUrl: cand.mediatorUrl,
                fileId: extractHubCloudDriveId(medRes.destination),
                filename: finalTitle,
                status: 'RESOLVED',
              });
              logger.discovered(`[XDMovies/parse-html] Resolved candidate ${cand.title} -> ${medRes.destination}`);
            }
          }
        } catch (bgErr) {
          logger.error(`[XDMovies/parse-html] Background resolution error: ${bgErr.message}`);
        }
      })();

      return res.json({
        success: true,
        count: savedRecords.length,
        records: savedRecords,
        activeScope: scope,
        activeQuality: quality,
      });
    }

    // Check if pasted HTML is from 4KHDHub / contains HubCloud buttons
    const is4KHDHubHtml = /4khdhub|hdhub4u/i.test(html) || /hubcloud/i.test(html);
    if (is4KHDHubHtml) {
      const { extract4KHDHubLinks } = await import('../providers/4khdhub/extractor.js');
      const { resolveMediatorFlow } = await import('../resolvers/mediator/browser.js');
      const { extractHubCloudDriveId, isHubCloudDriveUrl, fetchHubCloudMetadata } = await import('../providers/hubcloud/validator.js');

      const extracted = extract4KHDHubLinks(html, sourceUrl);
      const allExtractedLinks = extracted.links;
      const isMoviePage = extracted.contentType === 'movie' || (allExtractedLinks.length > 0 && allExtractedLinks.every((l) => l.scope === 'movie'));

      if (allExtractedLinks.length === 0) {
        // Check if pasted HTML is a search page with movie cards
        const cheerio = await import('cheerio');
        const $ = cheerio.load(html);
        const movieUrls = [];
        $('.movie-card, a[href*="-movie-"]').each((_, el) => {
          let href = $(el).attr('href') || '';
          if (href) {
            href = href.replace(/^\[\/?/, '/').replace(/\]\(.*\)$/, '');
            if (/-movie-\d+\/?$/i.test(href) || /-movie-/i.test(href)) {
              const fullUrl = href.startsWith('http') ? href : new URL(href, sourceUrl && sourceUrl.startsWith('http') ? sourceUrl : 'https://4khdhub.one/').href;
              if (!movieUrls.includes(fullUrl)) movieUrls.push(fullUrl);
            }
          }
        });
        if (movieUrls.length > 0) {
          logger.discovered(`[parse-html] Search page detected with ${movieUrls.length} movie(s): ${movieUrls.join(', ')}`);
          for (const mUrl of movieUrls) {
            await jobQueue.addJob(mUrl, { quality, scope });
          }
          return res.json({
            success: true,
            isSearchPage: true,
            movieCount: movieUrls.length,
            movies: movieUrls,
            message: `Found ${movieUrls.length} movies in search page, enqueued for scraping.`,
          });
        }
      }

      const savedRecords = [];
      for (const item of allExtractedLinks) {
        const title = item.filename || item.title || '4KHDHub Content';
        const itemScope = item.scope || (isMoviePage ? 'movie' : (item.episode !== null && item.episode !== undefined ? 'episode' : (item.season !== null && item.season !== undefined ? 'pack' : 'movie')));
        const rec = {
          sourceUrl,
          sourceDomain: sourceUrl && sourceUrl.startsWith('http') ? new URL(sourceUrl).hostname : '4khdhub.one',
          title,
          scope: itemScope,
          season: isMoviePage ? null : item.season,
          episode: isMoviePage ? null : item.episode,
          quality: item.quality,
          provider: 'HUBCLOUD',
          mediatorUrl: item.mediatorUrl,
          filename: item.filename || title,
          status: 'DISCOVERED',
        };
        const saved = await scrapedLinksRepo.saveLink(rec);
        savedRecords.push(saved);
      }

      // Filter candidates to actively resolve based on quality and scope
      let toResolve = [...allExtractedLinks];
      if (quality && quality !== 'all') {
        const filtered = toResolve.filter((l) => matchesQuality(l.quality, quality));
        if (filtered.length > 0) toResolve = filtered;
      }
      if (scope && scope !== 'all') {
        if (isMoviePage) {
          const filtered = toResolve.filter((l) => l.scope === 'movie');
          if (filtered.length > 0) toResolve = filtered;
        } else {
          const filtered = toResolve.filter((l) => l.scope === scope);
          if (filtered.length > 0) toResolve = filtered;
        }
      }


      const hkConcurrencyLimit = config.mediatorConcurrency;
      const hkBatchStart = Date.now();
      logger.parsing(`[4KHDHub/parse-html] Starting concurrent resolution: ${toResolve.length} link(s), concurrency=${hkConcurrencyLimit}`);

      // Fire-and-forget: return response to user immediately, resolve in background
      (async () => {
        try {
          const { results: resolutionResults, timings: batchTimings } = await runBoundedWithBrowser(
            toResolve.map((item, idx) => async (sharedBrowser) => {
              const workerStart = Date.now();
              logger.log('RESOLVER', `[4KHDHub BG Worker ${idx + 1}/${toResolve.length}] Resolving [${item.quality}] [${item.scope || 'episode'}] "${item.title}"`);

              const resolution = await resolveMediatorFlow(item.mediatorUrl, {
                meta: item,
                countdownTimeout: 35000,
                navigationTimeout: 20000,
                existingBrowser: sharedBrowser,
              });

              // Per-link timing breakdown
              const stages = resolution.stageDurations || {};
              logger.log('TIMING', `[4KHDHub BG Link ${idx + 1}/${toResolve.length}] Total: ${Date.now() - workerStart}ms | Nav: ${stages.MEDIATOR_OPEN || 0}ms | ExternalWait: ${(stages.WAITING || 0) + (stages.COUNTDOWN || 0)}ms | State: ${resolution.state}`);

              if (resolution.success && resolution.destination && isHubCloudDriveUrl(resolution.destination)) {
                let finalTitle = resolution.meta?.filename || resolution.meta?.title;
                if (!finalTitle || finalTitle === item.title || finalTitle === 'Unknown Title') {
                  const hubMeta = await fetchHubCloudMetadata(resolution.destination);
                  if (hubMeta?.filename) finalTitle = hubMeta.filename;
                }
                finalTitle = finalTitle || item.filename || item.title;

                await scrapedLinksRepo.saveLink({
                  sourceUrl,
                  sourceDomain: sourceUrl && sourceUrl.startsWith('http') ? new URL(sourceUrl).hostname : '4khdhub.one',
                  title: finalTitle,
                  scope: item.scope || (isMoviePage ? 'movie' : (item.episode !== null && item.episode !== undefined ? 'episode' : (item.season !== null && item.season !== undefined ? 'pack' : 'movie'))),
                  season: isMoviePage ? null : item.season,
                  episode: isMoviePage ? null : item.episode,
                  quality: item.quality,
                  provider: 'HUBCLOUD',
                  providerUrl: resolution.destination,
                  mediatorUrl: item.mediatorUrl,
                  fileId: extractHubCloudDriveId(resolution.destination),
                  filename: finalTitle,
                  status: 'RESOLVED',
                });
              }
              return resolution.state;
            }),
            hkConcurrencyLimit,
            { headless: true }
          );
          logger.log('TIMING', `[4KHDHub BG] Batch complete: ${toResolve.length} link(s) | Wall: ${Date.now() - hkBatchStart}ms | BrowserLaunch: ${batchTimings.browserStartMs}ms | Concurrency: ${hkConcurrencyLimit}`);
        } catch (bgErr) {
          logger.warning(`[4KHDHub BG] Concurrent resolution error: ${bgErr.message}`);
        }
      })();



      return res.json({
        success: true,
        count: savedRecords.length,
        records: savedRecords,
        activeScope: isMoviePage ? 'movie' : scope,
        activeQuality: quality,
      });
    }

    const { parseSourcePage } = await import('../sources/source-parser.js');
    const { extractGdflixFileId } = await import('../providers/gdflix.js');
    const { providerRegistry } = await import('../providers/provider-registry.js');

    const sourceData = parseSourcePage(html, sourceUrl);
    let discovered = sourceData.discoveredLinks;

    if (quality && quality !== 'all') {
      const normTarget = quality.toLowerCase().replace(/p$/, '');
      const filtered = discovered.filter((l) => {
        if (!l.quality) return false;
        return l.quality.toLowerCase().replace(/p$/, '') === normTarget;
      });
      if (filtered.length > 0) {
        discovered = filtered;
      }
    }

    if (scope && scope !== 'all') {
      const filtered = discovered.filter((l) => (l.scope || 'episode') === scope);
      if (filtered.length > 0) {
        discovered = filtered;
      }
    }

    const savedRecords = [];
    for (const item of discovered) {
      let destUrl = normalizeNexdriveUrl(item.resolvedUrl);
      const match = destUrl.match(/[?&]file=([a-zA-Z0-9+/=]+)/);
      if (match) {
        try {
          const raw = Buffer.from(match[1], 'base64').toString('utf8');
          const p = JSON.parse(raw);
          if (p.url) destUrl = p.url;
        } catch {}
      }

      // Exclude DotFlix / dtflix links so only genuine GDFLIX links are saved
      if (/dtflix|dotflix/i.test(destUrl)) {
        continue;
      }

      let provName = item.provider || 'LINK';
      const matchedProv = providerRegistry.findProvider(destUrl);
      if (matchedProv) {
        provName = matchedProv.name;
      } else if (destUrl.includes('gdflix') || destUrl.includes('dotflix') || destUrl.includes('dtflix')) {
        provName = 'GDFLIX';
      } else if (destUrl.includes('hubcloud')) {
        provName = 'HubCloud';
      } else if (destUrl.includes('vcloud') || /v-?cloud/i.test(item.buttonText || '')) {
        provName = 'V-Cloud';
      } else if (/nexdrive\.[a-z]{2,}\/genxfm/i.test(destUrl)) {
        provName = 'Nexdrive';
      }

      let fileId = extractGdflixFileId(destUrl);
      if (!fileId && /vcloud/i.test(destUrl)) {
        const { extractVCloudFileId } = await import('../providers/vcloud.js');
        fileId = extractVCloudFileId(destUrl);
      }
      if (!fileId && /nexdrive\.[a-z]{2,}\/genxfm/i.test(destUrl)) {
        const parts = destUrl.split('/').filter(Boolean);
        fileId = parts[parts.length - 1] || null;
      }

      const rec = {
        sourceUrl,
        sourceDomain: sourceData.sourceDomain,
        title: sourceData.title,
        year: sourceData.year,
        type: sourceData.type || 'tv',
        scope: item.scope || (item.episode !== null && item.episode !== undefined ? 'episode' : (item.season !== null && item.season !== undefined ? 'pack' : 'movie')),
        season: item.season ?? sourceData.season,
        episode: item.episode ?? sourceData.episode,
        quality: item.quality,
        codec: item.codec,
        sizeDisplay: item.sizeDisplay,
        provider: provName,
        providerUrl: destUrl,
        fileId,
        filename: item.filename || item.rowTitle || sourceData.title,
        status: 'RESOLVED',
        redirectChain: [destUrl],
        sourceToken: match ? match[1] : null,
      };

      const saved = await scrapedLinksRepo.saveLink(rec);
      savedRecords.push(saved);
    }

    return res.json({
      success: true,
      count: savedRecords.length,
      records: savedRecords,
      activeScope: scope,
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

    const isXDMoviesMed = /link\.xdmovies\.[a-z0-9.]+|latestnewsonline\.[a-z0-9.]+/i.test(urlToResolve);
    let resolution;
    if (isXDMoviesMed) {
      const { resolveXDMoviesMediator } = await import('../scrapers/xdmovies/mediator.js');
      const medRes = await resolveXDMoviesMediator(urlToResolve);
      resolution = {
        success: medRes.success,
        destination: medRes.destination,
        state: medRes.success ? 'HUBCLOUD_DETECTED' : 'ERROR',
        error: medRes.error,
        meta: medRes.metadata,
      };
    } else {
      const { resolveMediatorHttpFirst } = await import('../resolvers/mediator/http-first.js');
      resolution = await resolveMediatorHttpFirst(urlToResolve, {
        meta: link || {},
        countdownTimeout: 35000,
        navigationTimeout: 20000,
      });
    }

    if (resolution.success && resolution.destination) {
      let finalTitle = resolution.meta?.filename || resolution.meta?.title;
      if (!finalTitle || finalTitle === link?.title || finalTitle === 'Unknown Title') {
        const hubMeta = await fetchHubCloudMetadata(resolution.destination).catch(() => null);
        if (hubMeta?.filename) {
          finalTitle = hubMeta.filename;
        }
      }

      if (link) {
        link.providerUrl = resolution.destination;
        link.fileId = extractHubCloudDriveId(resolution.destination);
        link.status = 'RESOLVED';
        if (finalTitle) {
          link.filename = finalTitle;
          link.title = finalTitle;
        }
        await scrapedLinksRepo.saveLink(link);
      } else {
        // Auto-persist newly resolved standalone mediator link into catalogue!
        const driveId = extractHubCloudDriveId(resolution.destination);
        const autoDoc = {
          sourceUrl: urlToResolve,
          sourceDomain: 'link.xdmovies.wtf',
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
      return res.json({
        success: true,
        destination: resolution.destination,
        driveId: extractHubCloudDriveId(resolution.destination),
        state: resolution.state,
        title: link?.filename || link?.title || finalTitle || '',
      });
    } else {
      if (link) {
        link.status = resolution.state === 'CAPTCHA_REQUIRED' ? 'HUMAN_VERIFICATION_REQUIRED' : 'ERROR';
        link.error = resolution.error || 'Failed to resolve mediator link';
        await scrapedLinksRepo.saveLink(link);
      }
      return res.status(400).json({
        success: false,
        state: resolution.state,
        error: resolution.error || 'Failed to resolve mediator link',
      });
    }
  } catch (err) {
    logger.error(`Error resolving link: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
