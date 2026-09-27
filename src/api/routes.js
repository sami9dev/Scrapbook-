import express from 'express';
import { validateUrl } from '../utils/url.js';
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

  // Validate URL and SSRF controls
  const validation = validateUrl(url);
  if (!validation.valid) {
    logger.security(`Rejected invalid or dangerous scrape URL: ${url} (${validation.error})`);
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

    // Exclude intermediate mediator URLs
    links = links.filter((l) => !(l.providerUrl && l.providerUrl.includes('greenmotors')));

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
 * POST /api/parse-html
 * Parses raw HTML provided by the user and saves extracted records.
 */
router.post('/parse-html', async (req, res) => {
  const { html, sourceUrl = 'https://source-pasted.local/', quality = 'all', scope = 'all', reset, autoReset } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Field "html" is required.' });
  }

  try {
    if (reset || autoReset) {
      await scrapedLinksRepo.clear();
      await jobsRepo.clear();
      logger.database('Auto-reset completed before parsing direct HTML.');
    }

    // Check if pasted HTML is from XDMovies
    const isXDMoviesHtml = /xdmovies/i.test(sourceUrl) || /xdmovies/i.test(html) || /link\.xdmovies\.wtf/i.test(html);
    if (isXDMoviesHtml) {
      const { extractXDMoviesLinks } = await import('../providers/xdmovies/extractor.js');
      const { getXDMoviesMediatorUrl, resolveXDMoviesMediator } = await import('../resolvers/xdmovies/mediator.js');
      const { isHubCloudDriveUrl, extractHubCloudDriveId, fetchHubCloudMetadata } = await import('../providers/hubcloud/validator.js');

      const extracted = extractXDMoviesLinks(html, sourceUrl);
      const allExtractedLinks = extracted.allLinks || extracted.links;

      const savedRecords = [];
      for (const item of allExtractedLinks) {
        const rec = {
          sourceUrl,
          sourceDomain: sourceUrl && sourceUrl.startsWith('http') ? new URL(sourceUrl).hostname : 'top.xdmovies.wtf',
          title: item.filename || item.title,
          scope: item.scope,
          season: item.season,
          episode: item.episode,
          quality: item.quality,
          codec: item.codec,
          sizeDisplay: item.sizeDisplay,
          provider: 'HUBCLOUD',
          mediatorUrl: item.redirectUrl,
          filename: item.filename || item.title,
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
        const filtered = toResolve.filter((l) => l.scope === scope);
        if (filtered.length > 0) toResolve = filtered;
      }


      const concurrencyLimit = config.mediatorConcurrency;
      const batchStart = Date.now();
      logger.parsing(`[XDMovies/parse-html] Starting concurrent resolution: ${toResolve.length} link(s), concurrency=${concurrencyLimit}`);

      // Fire-and-forget background concurrent resolution. Results are saved as they complete.
      // For ≤2 items this is equivalent to the old sequential path but uses the same code path.
      (async () => {
        try {
          const { results: resolutionResults, timings: batchTimings } = await runBoundedWithBrowser(
            toResolve.map((item, idx) => async (sharedBrowser) => {
              const workerStart = Date.now();
              logger.log('RESOLVER', `[XDMovies BG Worker ${idx + 1}/${toResolve.length}] Resolving [${item.quality}] [${item.scope}] "${item.filename}"`);

              const medUrl = await getXDMoviesMediatorUrl(item.redirectUrl);
              if (!medUrl) return null;

              const resObj = await resolveXDMoviesMediator(medUrl, {
                meta: item,
                headless: false,
                existingBrowser: sharedBrowser,
              });

              logger.log('TIMING', `[XDMovies BG Link ${idx + 1}/${toResolve.length}] Total: ${Date.now() - workerStart}ms | State: ${resObj.state}`);

              if (resObj.success && resObj.destination && isHubCloudDriveUrl(resObj.destination)) {
                let finalTitle = resObj.meta?.filename || resObj.meta?.title || item.filename || item.title;
                const hubMeta = await fetchHubCloudMetadata(resObj.destination);
                if (hubMeta?.filename) finalTitle = hubMeta.filename;

                await scrapedLinksRepo.saveLink({
                  sourceUrl,
                  sourceDomain: sourceUrl && sourceUrl.startsWith('http') ? new URL(sourceUrl).hostname : 'top.xdmovies.wtf',
                  title: finalTitle,
                  scope: item.scope,
                  season: item.season,
                  episode: item.episode,
                  quality: item.quality,
                  codec: item.codec,
                  sizeDisplay: item.sizeDisplay,
                  provider: 'HUBCLOUD',
                  providerUrl: resObj.destination,
                  mediatorUrl: medUrl,
                  fileId: extractHubCloudDriveId(resObj.destination),
                  filename: finalTitle,
                  status: 'RESOLVED',
                });
              }
              return resObj.state;
            }),
            concurrencyLimit,
            { headless: false }
          );
          logger.log('TIMING', `[XDMovies BG] Batch complete: ${toResolve.length} link(s) | Wall: ${Date.now() - batchStart}ms | BrowserLaunch: ${batchTimings.browserStartMs}ms | Concurrency: ${concurrencyLimit}`);
        } catch (bgErr) {
          logger.warning(`[XDMovies BG] Concurrent resolution error: ${bgErr.message}`);
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

      const savedRecords = [];
      for (const item of allExtractedLinks) {
        const title = item.filename || item.title || '4KHDHub Content';
        const rec = {
          sourceUrl,
          sourceDomain: sourceUrl && sourceUrl.startsWith('http') ? new URL(sourceUrl).hostname : '4khdhub.one',
          title,
          scope: item.scope || (item.episode !== null && item.episode !== undefined ? 'episode' : (item.season !== null && item.season !== undefined ? 'pack' : 'movie')),
          season: item.season,
          episode: item.episode,
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
        const filtered = toResolve.filter((l) => l.scope === scope);
        if (filtered.length > 0) toResolve = filtered;
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
                  scope: item.scope || (item.episode !== null && item.episode !== undefined ? 'episode' : (item.season !== null && item.season !== undefined ? 'pack' : 'movie')),
                  season: item.season,
                  episode: item.episode,
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
        activeScope: scope,
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

    const savedRecords = [];
    for (const item of discovered) {
      let destUrl = item.resolvedUrl;
      const match = destUrl.match(/[?&]file=([a-zA-Z0-9+/=]+)/);
      if (match) {
        try {
          const raw = Buffer.from(match[1], 'base64').toString('utf8');
          const p = JSON.parse(raw);
          if (p.url) destUrl = p.url;
        } catch {}
      }

      let provName = item.provider || 'LINK';
      const matchedProv = providerRegistry.findProvider(destUrl);
      if (matchedProv) {
        provName = matchedProv.name;
      } else if (destUrl.includes('gdflix') || destUrl.includes('dotflix') || destUrl.includes('dtflix')) {
        provName = 'GDFLIX';
      } else if (destUrl.includes('hubcloud')) {
        provName = 'HubCloud';
      }

      const rec = {
        sourceUrl,
        sourceDomain: sourceData.sourceDomain,
        title: sourceData.title,
        year: sourceData.year,
        type: sourceData.type || 'tv',
        season: item.season ?? sourceData.season,
        episode: item.episode ?? sourceData.episode,
        quality: item.quality,
        codec: item.codec,
        sizeDisplay: item.sizeDisplay,
        provider: provName,
        providerUrl: destUrl,
        fileId: extractGdflixFileId(destUrl),
        filename: item.filename || item.rowTitle || sourceData.title,
        status: 'RESOLVED',
        redirectChain: [destUrl],
        sourceToken: match ? match[1] : null,
      };

      const saved = await scrapedLinksRepo.saveLink(rec);
      savedRecords.push(saved);
    }

    return res.json({ success: true, count: savedRecords.length, records: savedRecords });
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

    const isXDMovies = (link?.sourceDomain && link.sourceDomain.includes('xdmovies')) ||
      (urlToResolve && (urlToResolve.includes('xdmovies') || urlToResolve.includes('latestnewsonline.')));

    if (isXDMovies) {
      const { getXDMoviesMediatorUrl, resolveXDMoviesMediator } = await import('../resolvers/xdmovies/mediator.js');
      let targetMediator = urlToResolve;
      if (targetMediator.includes('link.xdmovies.wtf')) {
        targetMediator = await getXDMoviesMediatorUrl(targetMediator);
      }
      if (!targetMediator) {
        return res.status(400).json({ error: 'Could not resolve XDMovies mediator URL' });
      }

      const resolution = await resolveXDMoviesMediator(targetMediator, {
        meta: link || {},
        headless: false,
      });

      if (resolution.success && resolution.destination) {
        if (link) {
          link.providerUrl = resolution.destination;
          link.fileId = resolution.driveId;
          link.status = 'RESOLVED';
          await scrapedLinksRepo.saveLink(link);
        }
        return res.json({
          success: true,
          destination: resolution.destination,
          driveId: resolution.driveId,
          state: resolution.state,
        });
      } else {
        if (link) {
          link.status = resolution.state === 'CAPTCHA_REQUIRED' ? 'HUMAN_VERIFICATION_REQUIRED' : 'ERROR';
          await scrapedLinksRepo.saveLink(link);
        }
        return res.status(400).json({
          success: false,
          state: resolution.state,
          error: resolution.error || 'Failed to resolve mediator link',
        });
      }
    }

    const { resolveMediatorFlow } = await import('../resolvers/mediator/browser.js');
    const { extractHubCloudDriveId, fetchHubCloudMetadata } = await import('../providers/hubcloud/validator.js');

    const resolution = await resolveMediatorFlow(urlToResolve, {
      meta: link || {},
      countdownTimeout: 35000,
      navigationTimeout: 20000,
    });

    if (resolution.success && resolution.destination) {
      if (link) {
        link.providerUrl = resolution.destination;
        link.fileId = extractHubCloudDriveId(resolution.destination);
        link.status = 'RESOLVED';
        let finalTitle = resolution.meta?.filename || resolution.meta?.title;
        if (!finalTitle || finalTitle === link.title || finalTitle === 'Unknown Title') {
          const hubMeta = await fetchHubCloudMetadata(resolution.destination);
          if (hubMeta?.filename) {
            finalTitle = hubMeta.filename;
          }
        }
        if (finalTitle) {
          link.filename = finalTitle;
          link.title = finalTitle;
        }
        await scrapedLinksRepo.saveLink(link);
      }
      return res.json({
        success: true,
        destination: resolution.destination,
        driveId: extractHubCloudDriveId(resolution.destination),
        state: resolution.state,
      });
    } else {
      if (link) {
        link.status = resolution.state === 'CAPTCHA_REQUIRED' ? 'HUMAN_VERIFICATION_REQUIRED' : 'ERROR';
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
