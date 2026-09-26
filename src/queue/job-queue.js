import { config } from '../config/config.js';
import { logger } from '../logging/logger.js';
import { fetchWithControls } from '../discovery/http-client.js';
import { parseSourcePage } from '../sources/source-parser.js';
import { discoverExposedDestination } from '../discovery/link-discovery.js';
import { providerRegistry } from '../providers/provider-registry.js';
import { parseFilenameMetadata } from '../parsing/metadata-parser.js';
import { normalizeSize, matchesQuality } from '../utils/normalize.js';
import { scrapedLinksRepo, jobsRepo, SCRAPED_STATUS } from '../database/models.js';
import { extractGdflixFileId } from '../providers/gdflix.js';
import { extractOpaqueToken } from '../discovery/link-discovery.js';

// Pre-load registered providers
import '../providers/gdflix.js';

export class JobQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency ?? config.concurrency;
    this.activeWorkers = 0;
    this.queue = [];
  }

  /**
   * Adds a URL scraping job to the queue.
   * @param {string} url
   * @returns {Promise<object>} Created job document
   */
  async addJob(url, options = {}) {
    const targetQuality = typeof options === 'string' ? options : (options.quality || options.targetQuality || 'all');
    const targetScope = options.scope || options.targetScope || 'all';
    const job = await jobsRepo.createJob({
      url,
      targetQuality,
      targetScope,
    });
    logger.discovered(`Enqueued job ${job._id} for URL: ${url} (Quality: ${targetQuality}, Scope: ${targetScope})`);
    this.queue.push(job._id);
    this.processNext();
    return job;
  }

  /**
   * Triggers processing for next job if concurrency limits allow.
   */
  async processNext() {
    if (this.activeWorkers >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const jobId = this.queue.shift();
    this.activeWorkers++;

    try {
      await this.executeJob(jobId);
    } catch (err) {
      logger.error(`Unhandled error processing job ${jobId}: ${err.message}`);
    } finally {
      this.activeWorkers--;
      this.processNext();
    }
  }

  /**
   * Executes the full modular pipeline for a job.
   * @param {string} jobId
   */
  async executeJob(jobId) {
    const job = await jobsRepo.getJob(jobId);
    if (!job) return;

    logger.parsing(`Starting job ${jobId} for source URL: ${job.url}`);
    await jobsRepo.updateJob(jobId, { status: SCRAPED_STATUS.PARSING });

    const { extractHubCloudDriveId, isHubCloudDriveUrl, fetchHubCloudMetadata } = await import('../providers/hubcloud/validator.js');

    // Case A: User submitted a direct HubCloud Drive link
    if (isHubCloudDriveUrl(job.url)) {
      logger.discovered(`Job ${jobId} is already a direct HubCloud drive URL: ${job.url}`);
      const hubMeta = await fetchHubCloudMetadata(job.url);
      const fileTitle = hubMeta?.filename || 'HubCloud Destination Link';
      const parsedMeta = parseFilenameMetadata(fileTitle);

      await scrapedLinksRepo.saveLink({
        sourceUrl: job.url,
        sourceDomain: new URL(job.url).hostname,
        title: fileTitle,
        quality: parsedMeta.quality || job.targetQuality || 'unknown',
        provider: 'HUBCLOUD',
        providerUrl: job.url,
        fileId: extractHubCloudDriveId(job.url),
        filename: fileTitle,
        status: SCRAPED_STATUS.RESOLVED,
      });
      await jobsRepo.updateJob(jobId, {
        status: SCRAPED_STATUS.RESOLVED,
        extractedCount: 1,
      });
      return;
    }

    // Case B: User submitted an intermediate mediator link (e.g. greenmotors.club/?id=...)
    const isDirectMediator = /greenmotors|fast-share|fastdl|mediator|\?id=/i.test(job.url);
    if (isDirectMediator) {
      logger.discovered(`Routing job ${jobId} directly to mediator resolver: ${job.url}`);
      const { resolveMediatorFlow } = await import('../resolvers/mediator/browser.js');
      const { parseFilenameMetadata } = await import('../parsing/metadata-parser.js');

      const resolution = await resolveMediatorFlow(job.url, {
        countdownTimeout: 35000,
        navigationTimeout: 20000,
      });

      if (resolution.success && resolution.destination && isHubCloudDriveUrl(resolution.destination)) {
        let fileTitle = resolution.meta?.filename || resolution.meta?.title;
        if (!fileTitle || fileTitle === 'Unknown Title') {
          const hubMeta = await fetchHubCloudMetadata(resolution.destination);
          if (hubMeta?.filename) {
            fileTitle = hubMeta.filename;
          }
        }
        fileTitle = fileTitle || 'HubCloud Destination Link';
        const parsedMeta = parseFilenameMetadata(fileTitle);

        await scrapedLinksRepo.saveLink({
          sourceUrl: job.url,
          sourceDomain: new URL(job.url).hostname,
          title: fileTitle,
          quality: parsedMeta.quality || job.targetQuality || 'unknown',
          provider: 'HUBCLOUD',
          providerUrl: resolution.destination,
          fileId: extractHubCloudDriveId(resolution.destination),
          filename: fileTitle,
          status: SCRAPED_STATUS.RESOLVED,
        });

        await jobsRepo.updateJob(jobId, {
          status: SCRAPED_STATUS.RESOLVED,
          extractedCount: 1,
        });
      } else {
        await jobsRepo.updateJob(jobId, {
          status: resolution.state === 'CAPTCHA_REQUIRED' ? SCRAPED_STATUS.HUMAN_VERIFICATION_REQUIRED : SCRAPED_STATUS.ERROR,
          error: resolution.error || 'Failed to resolve mediator into HubCloud drive destination',
        });
      }
      return;
    }

    // Case C: XDMovies pipeline (top.xdmovies.wtf)
    const isXDMovies = /xdmovies/i.test(job.url);
    if (isXDMovies) {
      logger.discovered(`Routing job ${jobId} to dedicated XDMovies pipeline: ${job.url}`);
      let html = null;
      let sourceFetch = await fetchWithControls(job.url);

      if (sourceFetch.success && (sourceFetch.body.includes('pack-card') || sourceFetch.body.includes('episode-card'))) {
        html = sourceFetch.body;
      } else {
        // Cloudflare challenge present on top.xdmovies.wtf; use browser-based fetcher
        logger.discovered(`Attempting browser fetch for Cloudflare-protected XDMovies page: ${job.url}`);
        const { chromium } = await import('playwright');
        let browser = null;
        try {
          browser = await chromium.launch({
            channel: 'chrome',
            headless: false,
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
          }).catch(() => chromium.launch({
            headless: false,
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
          }));

          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
          });
          const page = await context.newPage();
          await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});

          // Observe for up to 25s for Cloudflare verification to settle
          for (let i = 0; i < 25; i++) {
            await page.waitForTimeout(1000);
            const pageTitle = await page.title().catch(() => '');
            if (pageTitle && !pageTitle.includes('moment') && !pageTitle.includes('Attention Required')) {
              const body = await page.content();
              if (body.includes('pack-card') || body.includes('episode-card') || body.includes('download')) {
                html = body;
                break;
              }
            }
          }
        } catch (pwErr) {
          logger.warning(`Browser fetch error on XDMovies: ${pwErr.message}`);
        } finally {
          if (browser) await browser.close().catch(() => {});
        }
      }

      if (!html) {
        logger.warning(`Job ${jobId} encountered Cloudflare challenge on XDMovies. User can paste HTML directly.`);
        await jobsRepo.updateJob(jobId, {
          status: SCRAPED_STATUS.HUMAN_VERIFICATION_REQUIRED,
          error: 'Cloudflare security verification required on top.xdmovies.wtf. Please complete verification in the browser window or use "⚡ Or Paste HTML Directly" below for instant extraction.',
        });
        return;
      }

      const { extractXDMoviesLinks } = await import('../providers/xdmovies/extractor.js');
      const { getXDMoviesMediatorUrl, resolveXDMoviesMediator } = await import('../resolvers/xdmovies/mediator.js');

      const extracted = extractXDMoviesLinks(html, job.url);
      const allExtractedLinks = extracted.allLinks || extracted.links;

      // 1. Save ALL candidate links to database so that both Single Episodes and Complete Season Packs in ALL qualities are preserved
      for (const item of allExtractedLinks) {
        await scrapedLinksRepo.saveLink({
          sourceUrl: job.url,
          sourceDomain: new URL(job.url).hostname,
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
        });
      }

      // 2. Select candidates to resolve based on user's targetQuality and targetScope
      let toResolve = [...allExtractedLinks];
      if (job.targetQuality && job.targetQuality !== 'all') {
        const filtered = toResolve.filter((l) => matchesQuality(l.quality, job.targetQuality));
        if (filtered.length > 0) toResolve = filtered;
      }
      if (job.targetScope && job.targetScope !== 'all') {
        const filtered = toResolve.filter((l) => l.scope === job.targetScope);
        if (filtered.length > 0) toResolve = filtered;
      }

      let resolvedCount = 0;
      for (const item of toResolve) {
        logger.log('RESOLVER', `[XDMovies] Resolving [${item.quality}] [${item.scope}] "${item.filename}"`);
        const mediatorUrl = await getXDMoviesMediatorUrl(item.redirectUrl);
        if (!mediatorUrl) continue;

        const resolution = await resolveXDMoviesMediator(mediatorUrl, {
          meta: item,
          headless: false,
        });

        if (resolution.success && resolution.destination && isHubCloudDriveUrl(resolution.destination)) {
          resolvedCount++;
          let finalTitle = resolution.meta?.filename || resolution.meta?.title || item.filename || item.title;
          const hubMeta = await fetchHubCloudMetadata(resolution.destination);
          if (hubMeta?.filename) finalTitle = hubMeta.filename;

          await scrapedLinksRepo.saveLink({
            sourceUrl: job.url,
            sourceDomain: new URL(job.url).hostname,
            title: finalTitle,
            scope: item.scope,
            season: item.season,
            episode: item.episode,
            quality: item.quality,
            codec: item.codec,
            sizeDisplay: item.sizeDisplay,
            provider: 'HUBCLOUD',
            providerUrl: resolution.destination,
            mediatorUrl,
            fileId: extractHubCloudDriveId(resolution.destination),
            filename: finalTitle,
            status: SCRAPED_STATUS.RESOLVED,
          });
        }
      }

      await jobsRepo.updateJob(jobId, {
        status: SCRAPED_STATUS.RESOLVED,
        extractedCount: resolvedCount || allExtractedLinks.length,
      });
      return;
    }

    // Step 1: Fetch Source Page for other providers
    const sourceFetch = await fetchWithControls(job.url);

    if (sourceFetch.verificationRequired) {
      logger.warning(`Job ${jobId} encountered HUMAN_VERIFICATION_REQUIRED on source page`);
      await jobsRepo.updateJob(jobId, {
        status: SCRAPED_STATUS.HUMAN_VERIFICATION_REQUIRED,
        error: 'Manual verification required.',
        challengeResult: sourceFetch.challengeResult,
      });
      return;
    }

    if (!sourceFetch.success) {
      logger.error(`Job ${jobId} failed fetching source page: ${sourceFetch.error}`);
      await jobsRepo.updateJob(jobId, {
        status: sourceFetch.errorStatus || SCRAPED_STATUS.ERROR,
        error: sourceFetch.error,
      });
      return;
    }

    // Step 2: Parse Source Page
    const is4KHDHub = /4khdhub|hdhub4u/i.test(job.url) || /4khdhub/i.test(sourceFetch.body) || /hubcloud/i.test(sourceFetch.body);
    if (is4KHDHub) {
      logger.discovered(`Routing job ${jobId} to dedicated 4KHDHub/HubCloud pipeline`);
      const { extract4KHDHubLinks } = await import('../providers/4khdhub/extractor.js');
      const { resolveMediatorFlow } = await import('../resolvers/mediator/browser.js');

      const extracted = extract4KHDHubLinks(sourceFetch.body, sourceFetch.finalUrl || job.url);
      const allExtractedLinks = extracted.links;

      // 1. Save ALL candidate links to database so that both Single Episodes and Complete Season Packs in ALL qualities are preserved
      for (const item of allExtractedLinks) {
        const title = item.filename || item.title || '4KHDHub Content';
        await scrapedLinksRepo.saveLink({
          sourceUrl: job.url,
          sourceDomain: new URL(job.url).hostname,
          title,
          scope: item.scope || (item.episode !== null && item.episode !== undefined ? 'episode' : (item.season !== null && item.season !== undefined ? 'pack' : 'movie')),
          season: item.season,
          episode: item.episode,
          quality: item.quality,
          provider: 'HUBCLOUD',
          mediatorUrl: item.mediatorUrl,
          filename: item.filename || title,
          status: 'DISCOVERED',
        });
      }

      // 2. Select candidates to resolve based on user's targetQuality and targetScope
      let toResolve = [...allExtractedLinks];
      if (job.targetQuality && job.targetQuality !== 'all') {
        const filtered = toResolve.filter((l) => matchesQuality(l.quality, job.targetQuality));
        if (filtered.length > 0) toResolve = filtered;
      }
      if (job.targetScope && job.targetScope !== 'all') {
        const filtered = toResolve.filter((l) => l.scope === job.targetScope);
        if (filtered.length > 0) toResolve = filtered;
      }

      logger.parsing(`Found ${allExtractedLinks.length} total link(s), resolving ${toResolve.length} candidate(s) for "${extracted.title}" (Scope: ${job.targetScope || 'all'}, Quality: ${job.targetQuality || 'all'})`);

      let resolvedCount = 0;
      for (const item of toResolve) {
        logger.log('RESOLVER', `Resolving mediator for [${item.quality}] [${item.scope || 'episode'}] "${item.title}"`);
        const resolution = await resolveMediatorFlow(item.mediatorUrl, {
          meta: item,
          countdownTimeout: 35000,
          navigationTimeout: 20000,
        });

        if (resolution.success && resolution.destination && isHubCloudDriveUrl(resolution.destination)) {
          resolvedCount++;

          let finalTitle = resolution.meta?.filename || resolution.meta?.title;
          if (!finalTitle || finalTitle === item.title || finalTitle === 'Unknown Title') {
            const hubMeta = await fetchHubCloudMetadata(resolution.destination);
            if (hubMeta?.filename) {
              finalTitle = hubMeta.filename;
            }
          }
          finalTitle = finalTitle || item.filename || item.title;

          await scrapedLinksRepo.saveLink({
            sourceUrl: job.url,
            sourceDomain: new URL(job.url).hostname,
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
            status: SCRAPED_STATUS.RESOLVED,
          });
        } else {
          logger.warning(`Mediator resolution skipped/failed for "${item.title}" (${resolution.state})`);
        }
      }

      await jobsRepo.updateJob(jobId, {
        status: SCRAPED_STATUS.RESOLVED,
        extractedCount: resolvedCount || allExtractedLinks.length,
      });
      return;
    }

    const sourceData = parseSourcePage(sourceFetch.body, sourceFetch.finalUrl);
    let discovered = sourceData.discoveredLinks;
    const targetQuality = job.targetQuality || 'all';

    if (targetQuality && targetQuality !== 'all') {
      const normTarget = targetQuality.toLowerCase().replace(/p$/, ''); // e.g. '2160', '1080', '720', '480'
      const filtered = discovered.filter((l) => {
        if (!l.quality) return false;
        const normLinkQ = l.quality.toLowerCase().replace(/p$/, '');
        return normLinkQ === normTarget;
      });

      if (filtered.length > 0) {
        logger.discovered(`Filtered links by quality [${targetQuality}]: ${filtered.length} matching candidate links selected`);
        discovered = filtered;
      } else {
        logger.warning(`No candidate links matched target quality [${targetQuality}]. Processing all discovered links.`);
      }
    }

    const resolvedLinks = [];
    let hasChallenges = false;

    // Step 3: Follow candidate links and intermediate pages
    for (const linkItem of discovered) {
      const targetUrl = linkItem.resolvedUrl;

      // If already directly a recognized provider link
      let provider = linkItem.provider ? providerRegistry.findProvider(targetUrl) : null;
      let providerUrl = targetUrl;
      let sourceToken = null;
      let redirectChain = [];

      // If it is an intermediate page, fetch and inspect it
      if (!provider && linkItem.isIntermediate) {
        logger.discovered(`Inspecting intermediate candidate: ${targetUrl}`);
        const intermediateFetch = await fetchWithControls(targetUrl);

        if (intermediateFetch.verificationRequired) {
          hasChallenges = true;
          logger.warning(`Intermediate candidate requires human verification: ${targetUrl}`);
          continue;
        }

        if (intermediateFetch.success) {
          redirectChain = intermediateFetch.redirectChain;
          const discovery = discoverExposedDestination(intermediateFetch.body, intermediateFetch.finalUrl);

          if (discovery.status === 'HUMAN_VERIFICATION_REQUIRED') {
            hasChallenges = true;
            continue;
          }

          if (discovery.status === 'DISCOVERED' && discovery.destinationUrl) {
            providerUrl = discovery.destinationUrl;
            provider = providerRegistry.findProvider(providerUrl);
            sourceToken = discovery.sourceToken;
          } else if (discovery.status === 'UNRESOLVED') {
            // Section 13: HTTP parser did not find destination -> try Playwright for authorized JS rendering
            logger.discovered(`Attempting browser rendering for intermediate page: ${targetUrl}`);
            const { renderWithBrowser } = await import('../discovery/browser-fetcher.js');
            const browserResult = await renderWithBrowser(targetUrl);

            if (browserResult.verificationRequired) {
              hasChallenges = true;
              logger.warning(`Browser DOM presented human verification challenge on: ${targetUrl}`);
              continue;
            }

            if (browserResult.success && browserResult.html) {
              const domDiscovery = discoverExposedDestination(browserResult.html, browserResult.finalUrl || targetUrl);
              if (domDiscovery.status === 'DISCOVERED' && domDiscovery.destinationUrl) {
                providerUrl = domDiscovery.destinationUrl;
                provider = providerRegistry.findProvider(providerUrl);
                sourceToken = domDiscovery.sourceToken;
              }
            }
          }
        }
      }

      // Step 4: Parse Provider page if provider was detected
      if (provider) {
        logger.provider(`Processing provider [${provider.name}] at ${providerUrl}`);
        const providerFetch = await fetchWithControls(providerUrl, { timeout: 6000, maxRetries: 1 });

        if (providerFetch.verificationRequired) {
          hasChallenges = true;
          logger.warning(`Provider requires human verification: ${providerUrl}`);
          const challengeQuality = linkItem.quality || sourceData.quality || null;
          const challengeCodec = linkItem.codec || sourceData.codec || null;
          const challengeSize = linkItem.sizeDisplay || sourceData.sizeDisplay || null;
          const { sizeBytes: challengeBytes } = normalizeSize(challengeSize);

          const challengeRecord = {
            sourceUrl: job.url,
            sourceDomain: sourceData.sourceDomain,
            title: sourceData.title,
            year: sourceData.year,
            type: sourceData.type || 'tv',
            season: linkItem.season ?? sourceData.season,
            episode: linkItem.episode ?? sourceData.episode,
            quality: challengeQuality,
            codec: challengeCodec,
            sizeBytes: challengeBytes || 0,
            sizeDisplay: challengeSize,
            provider: provider.name,
            providerUrl: providerFetch.finalUrl || providerUrl,
            fileId: extractGdflixFileId(providerFetch.finalUrl || providerUrl),
            filename: linkItem.filename || linkItem.rowTitle || null,
            status: SCRAPED_STATUS.HUMAN_VERIFICATION_REQUIRED,
            redirectChain: [...redirectChain, ...providerFetch.redirectChain],
            sourceToken,
          };
          const saved = await scrapedLinksRepo.saveLink(challengeRecord);
          resolvedLinks.push(saved);
          continue;
        }

        if (!providerFetch.success) {
          logger.warning(`Provider fetch failed (${providerFetch.status}): ${providerUrl}`);
          const errQuality = linkItem.quality || sourceData.quality || null;
          const errCodec = linkItem.codec || sourceData.codec || null;
          const errSize = linkItem.sizeDisplay || sourceData.sizeDisplay || null;
          const { sizeBytes: errBytes } = normalizeSize(errSize);

          const errRecord = {
            sourceUrl: job.url,
            sourceDomain: sourceData.sourceDomain,
            title: sourceData.title,
            year: sourceData.year,
            type: sourceData.type || 'tv',
            season: linkItem.season ?? sourceData.season,
            episode: linkItem.episode ?? sourceData.episode,
            quality: errQuality,
            codec: errCodec,
            sizeBytes: errBytes || 0,
            sizeDisplay: errSize,
            provider: provider.name,
            providerUrl: providerFetch.finalUrl || providerUrl,
            fileId: extractGdflixFileId(providerFetch.finalUrl || providerUrl),
            filename: linkItem.filename || linkItem.rowTitle || null,
            status: providerFetch.status === 403 ? SCRAPED_STATUS.ACCESS_DENIED : SCRAPED_STATUS.ERROR,
            redirectChain: [...redirectChain, ...providerFetch.redirectChain],
            sourceToken,
          };
          const saved = await scrapedLinksRepo.saveLink(errRecord);
          resolvedLinks.push(saved);
          continue;
        }

        const providerResult = await provider.parser(providerFetch.body, providerFetch.finalUrl);
        const finalFilename = providerResult.filename || linkItem.filename || linkItem.rowTitle || null;
        const metaFromFilename = parseFilenameMetadata(finalFilename);

        const finalQuality = metaFromFilename.quality || linkItem.quality || providerResult.quality || sourceData.quality || null;
        const finalCodec = metaFromFilename.codec || linkItem.codec || providerResult.codec || sourceData.codec || null;
        const finalSizeDisplay = providerResult.sizeDisplay || linkItem.sizeDisplay || sourceData.sizeDisplay || null;
        const { sizeBytes: computedBytes } = normalizeSize(finalSizeDisplay);
        const finalSizeBytes = providerResult.sizeBytes || computedBytes || 0;

        const fullRecord = {
          sourceUrl: job.url,
          sourceDomain: sourceData.sourceDomain,
          title: sourceData.title || metaFromFilename.title,
          year: sourceData.year || metaFromFilename.year,
          type: sourceData.type || 'tv',
          season: metaFromFilename.season ?? linkItem.season ?? sourceData.season,
          episode: metaFromFilename.episode ?? linkItem.episode ?? sourceData.episode,
          quality: finalQuality,
          codec: finalCodec,
          provider: provider.name,
          providerUrl: providerResult.providerUrl,
          fileId: providerResult.fileId,
          filename: finalFilename,
          format: providerResult.format || metaFromFilename.extension,
          sizeBytes: finalSizeBytes,
          sizeDisplay: finalSizeDisplay,
          mirrors: providerResult.mirrors || [],
          status: SCRAPED_STATUS.RESOLVED,
          redirectChain: [...redirectChain, ...providerFetch.redirectChain],
          sourceToken,
        };

        const saved = await scrapedLinksRepo.saveLink(fullRecord);
        resolvedLinks.push(saved);
      }

      // Cross-link companion filenames for same-release records
      const knownFilenames = new Map();
      for (const rec of resolvedLinks) {
        if (rec.filename) {
          const isPack = (rec.providerUrl || '').includes('/pack/');
          const key = `${rec.quality || ''}-${rec.codec || ''}-${rec.season || ''}-${rec.episode || ''}-${isPack ? 'pack' : 'file'}`;
          knownFilenames.set(key, rec.filename);
        }
      }

      for (let i = 0; i < resolvedLinks.length; i++) {
        const rec = resolvedLinks[i];
        if (!rec.filename) {
          const isPack = (rec.providerUrl || '').includes('/pack/');
          const key = `${rec.quality || ''}-${rec.codec || ''}-${rec.season || ''}-${rec.episode || ''}-${isPack ? 'pack' : 'file'}`;
          if (knownFilenames.has(key)) {
            rec.filename = knownFilenames.get(key);
            await scrapedLinksRepo.saveLink(rec);
          }
        }
      }
    }

    // If no provider records were created but candidates with tokens were found, record unresolved items per Section 7
    if (resolvedLinks.length === 0 && discovered.length > 0) {
      for (const linkItem of discovered.slice(0, 5)) {
        const token = extractOpaqueToken(linkItem.resolvedUrl);
        const unresolvedRecord = {
          sourceUrl: job.url,
          sourceDomain: sourceData.sourceDomain,
          title: sourceData.title,
          year: sourceData.year,
          type: sourceData.type || 'tv',
          season: linkItem.season ?? sourceData.season,
          episode: linkItem.episode ?? sourceData.episode,
          quality: linkItem.quality || sourceData.quality || null,
          codec: linkItem.codec || sourceData.codec || null,
          sizeDisplay: linkItem.sizeDisplay || null,
          provider: 'UNRESOLVED',
          providerUrl: linkItem.resolvedUrl,
          fileId: null,
          filename: linkItem.filename || linkItem.rowTitle || null,
          status: SCRAPED_STATUS.PARTIAL,
          redirectChain: [],
          sourceToken: token,
        };
        const saved = await scrapedLinksRepo.saveLink(unresolvedRecord);
        resolvedLinks.push(saved);
      }
    }

    // Determine final job status
    let finalStatus = SCRAPED_STATUS.RESOLVED;
    const hasResolved = resolvedLinks.some((l) => l.status === SCRAPED_STATUS.RESOLVED);
    const hasVerification = resolvedLinks.some((l) => l.status === SCRAPED_STATUS.HUMAN_VERIFICATION_REQUIRED) || hasChallenges;

    if (!hasResolved) {
      if (hasVerification) {
        finalStatus = SCRAPED_STATUS.HUMAN_VERIFICATION_REQUIRED;
      } else {
        finalStatus = SCRAPED_STATUS.PARTIAL;
      }
    } else if (hasVerification) {
      finalStatus = SCRAPED_STATUS.PARTIAL;
    }

    await jobsRepo.updateJob(jobId, {
      status: finalStatus,
      resultsCount: resolvedLinks.length,
      extractedLinks: resolvedLinks.map((l) => l._id),
    });

    logger.database(`Job ${jobId} finished with status ${finalStatus}. Extracted: ${resolvedLinks.length} links.`);
  }
}

export const jobQueue = new JobQueue();
export default jobQueue;
