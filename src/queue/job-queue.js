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
import { runBoundedWithBrowser } from '../utils/concurrency.js';

// Pre-load registered providers
import '../providers/gdflix.js';

export class JobQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency ?? config.concurrency;
    this.activeWorkers = 0;
    this.queue = [];
    this.cancelledJobs = new Set();
    this.activeJobIds = new Set();
  }

  /**
   * Cancels all queued and active jobs immediately.
   */
  cancelAll() {
    this.queue = [];
    for (const id of this.activeJobIds) {
      this.cancelledJobs.add(id);
    }
    logger.warning(`JobQueue: Cancelled all queued and active jobs (${this.cancelledJobs.size} total)`);
  }

  isCancelled(jobId) {
    return this.cancelledJobs.has(jobId);
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
    if (this.isCancelled(jobId)) {
      this.cancelledJobs.delete(jobId);
      return this.processNext();
    }

    this.activeWorkers++;
    this.activeJobIds.add(jobId);

    try {
      await this.executeJob(jobId);
    } catch (err) {
      logger.error(`Unhandled error processing job ${jobId}: ${err.message}`);
    } finally {
      this.activeWorkers--;
      this.activeJobIds.delete(jobId);
      this.cancelledJobs.delete(jobId);
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

    // Case C: XDMovies pipeline (huh.xdmovies.wtf, top.xdmovies.wtf, link.xdmovies.wtf, etc.)
    const { isXDMoviesUrl, isXDMoviesMediatorUrl } = await import('../scrapers/xdmovies/types.js');
    const isXDMoviesMed = isXDMoviesMediatorUrl(job.url);
    const isXDMoviesHost = isXDMoviesUrl(job.url);

    if (isXDMoviesMed) {
      logger.discovered(`Routing job ${jobId} directly to XDMovies mediator resolver: ${job.url}`);
      const { resolveXDMoviesMediator } = await import('../scrapers/xdmovies/mediator.js');
      const { extractHubCloudDriveId, isHubCloudDriveUrl, fetchHubCloudMetadata } = await import('../providers/hubcloud/validator.js');

      const resolution = await resolveXDMoviesMediator(job.url, { headless: true });
      if (resolution.success && resolution.destination && isHubCloudDriveUrl(resolution.destination)) {
        let fileTitle = resolution.metadata?.filename || resolution.metadata?.title;
        if (!fileTitle || fileTitle === 'Unknown Title') {
          const hubMeta = await fetchHubCloudMetadata(resolution.destination);
          if (hubMeta?.filename) fileTitle = hubMeta.filename;
        }
        fileTitle = fileTitle || 'XDMovies Destination Link';
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
        logger.discovered(`[XDMovies] Direct mediator job ${jobId} resolved to: ${resolution.destination}`);
      } else {
        await jobsRepo.updateJob(jobId, {
          status: SCRAPED_STATUS.ERROR,
          error: resolution.error || 'Failed to resolve XDMovies mediator link into HubCloud destination',
        });
      }
      return;
    }

    if (isXDMoviesHost) {
      logger.discovered(`Routing job ${jobId} to dedicated XDMovies pipeline: ${job.url}`);
      const { fetchXDMoviesPage } = await import('../scrapers/xdmovies/browser-fetch.js');
      const { parseXDMoviesCatalogue } = await import('../scrapers/xdmovies/catalogue.js');
      const { resolveXDMoviesMediator } = await import('../scrapers/xdmovies/mediator.js');
      const { extractHubCloudDriveId, isHubCloudDriveUrl, fetchHubCloudMetadata } = await import('../providers/hubcloud/validator.js');
      const { recordInCatalog } = await import('../utils/catalog-store.js');
      const cheerio = await import('cheerio');

      const fetchResult = await fetchXDMoviesPage(job.url, { headless: true });

      if (!fetchResult.success || !fetchResult.html) {
        logger.warning(`Job ${jobId} failed fetching XDMovies page: ${fetchResult.error}`);
        await jobsRepo.updateJob(jobId, {
          status: SCRAPED_STATUS.ERROR,
          error: fetchResult.error || 'Failed to fetch XDMovies page HTML',
        });
        return;
      }

      // Check if Cloudflare challenge was not cleared
      if (
        fetchResult.html.includes('Just a moment...') &&
        !fetchResult.html.includes('download-item') &&
        !fetchResult.html.includes('episode-card') &&
        !fetchResult.html.includes('/movies/')
      ) {
        logger.warning(`Job ${jobId} encountered Cloudflare challenge on XDMovies`);
        await jobsRepo.updateJob(jobId, {
          status: SCRAPED_STATUS.HUMAN_VERIFICATION_REQUIRED,
          error: 'Cloudflare Turnstile verification required on XDMovies.',
        });
        return;
      }

      const catalogue = parseXDMoviesCatalogue(fetchResult.html, fetchResult.finalUrl || job.url);
      const isMoviePage = catalogue.type === 'movie';

      // Flatten releases and download links into candidate link list
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

      // If no download links, check if this is a catalog, homepage, or category archive page
      if (allExtractedLinks.length === 0) {
        const $ = cheerio.load(fetchResult.html);
        const postUrls = [];
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href');
          if (href && /\/(?:movies|series)\/[a-z0-9-]+/i.test(href)) {
            if (!/\/category\/|\/page\/|\/tag\/|\/genre\//i.test(href)) {
              const fullUrl = href.startsWith('http') ? href : new URL(href, job.url).href;
              if (!postUrls.includes(fullUrl)) postUrls.push(fullUrl);
            }
          }
        });

        if (postUrls.length > 0) {
          logger.discovered(`[XDMovies] Catalog/Archive page detected with ${postUrls.length} post(s): ${postUrls.slice(0, 5).join(', ')}...`);
          for (const pUrl of postUrls) {
            await this.addJob(pUrl, { quality: job.targetQuality, scope: job.targetScope });
          }
          await jobsRepo.updateJob(jobId, {
            status: SCRAPED_STATUS.RESOLVED,
            extractedCount: postUrls.length,
          });
          return;
        }

        // Truly empty or unrecognized page
        logger.warning(`Job ${jobId} found no releases or post cards on XDMovies page`);
        await jobsRepo.updateJob(jobId, {
          status: SCRAPED_STATUS.RESOLVED,
          extractedCount: 0,
        });
        return;
      }

      // 1. Record content in Catalog Store
      recordInCatalog({
        title: catalogue.title || 'XDMovies Content',
        url: job.url,
        format: isMoviePage ? 'Movie' : 'Series',
        platform: 'XDMovies',
      });

      // 2. Save ALL candidate links to database with status: 'DISCOVERED'
      for (const item of allExtractedLinks) {
        await scrapedLinksRepo.saveLink({
          sourceUrl: job.url,
          sourceDomain: new URL(job.url).hostname,
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
        });
      }

      // 3. Filter candidates based on targetQuality and targetScope
      let toResolve = [...allExtractedLinks];
      if (job.targetQuality && job.targetQuality !== 'all') {
        const filtered = toResolve.filter((l) => matchesQuality(l.quality, job.targetQuality));
        if (filtered.length > 0) toResolve = filtered;
      }
      if (job.targetScope && job.targetScope !== 'all') {
        if (isMoviePage) {
          const filtered = toResolve.filter((l) => l.scope === 'movie');
          if (filtered.length > 0) toResolve = filtered;
        } else {
          const filtered = toResolve.filter((l) => l.scope === job.targetScope);
          if (filtered.length > 0) toResolve = filtered;
        }
      }

      logger.parsing(`[XDMovies] Discovered ${allExtractedLinks.length} total link(s). Resolving top matching candidate(s) for "${catalogue.title}" (Content: ${isMoviePage ? 'Movie' : 'Series'}, Scope: ${job.targetScope || 'all'}, Quality: ${job.targetQuality || 'all'})`);

      // 4. Resolve candidate mediator link(s) to final HubCloud destination
      // Resolve up to 2 candidates immediately; others remain in DB as DISCOVERED
      const candidatesToResolve = toResolve.slice(0, 2);
      let resolvedCount = 0;

      for (const item of candidatesToResolve) {
        logger.discovered(`[XDMovies] Resolving mediator for candidate "${item.title}" (${item.quality}) -> ${item.mediatorUrl}`);
        const resolution = await resolveXDMoviesMediator(item.mediatorUrl, { headless: true });

        if (resolution.success && resolution.destination && isHubCloudDriveUrl(resolution.destination)) {
          let finalTitle = resolution.metadata?.filename || resolution.metadata?.title;
          if (!finalTitle || finalTitle === 'Unknown Title') {
            const hubMeta = await fetchHubCloudMetadata(resolution.destination);
            if (hubMeta?.filename) finalTitle = hubMeta.filename;
          }
          finalTitle = finalTitle || item.title;
          resolvedCount++;

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
            mediatorUrl: item.mediatorUrl,
            fileId: extractHubCloudDriveId(resolution.destination),
            filename: finalTitle,
            status: SCRAPED_STATUS.RESOLVED,
          });
          logger.discovered(`[XDMovies] Successfully resolved: ${item.title} -> ${resolution.destination}`);
        } else {
          logger.warning(`[XDMovies] Failed to resolve mediator for ${item.title}: ${resolution.error || 'Unknown error'}`);
        }
      }

      await jobsRepo.updateJob(jobId, {
        status: SCRAPED_STATUS.RESOLVED,
        extractedCount: resolvedCount || allExtractedLinks.length,
      });
      logger.discovered(`[XDMovies] Job ${jobId} completed. ${resolvedCount} link(s) resolved to HubCloud, ${allExtractedLinks.length} candidate(s) saved in DB.`);
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
    const is4KHDHub = /4khdhub|hdhub4u|4khub4u/i.test(job.url) || /4khdhub|4khub4u/i.test(sourceFetch.body) || /hubcloud/i.test(sourceFetch.body);
    if (is4KHDHub) {
      logger.discovered(`Routing job ${jobId} to dedicated 4KHDHub/HubCloud pipeline`);
      const { parse4KHubCatalogue, resolveCatalogueLinks } = await import('../scrapers/4khub4u/catalogue.js');
      const { isHubCloudDriveUrl, extractHubCloudDriveId } = await import('../providers/hubcloud/validator.js');
      const { recordInCatalog } = await import('../utils/catalog-store.js');

      const rawCatalogue = parse4KHubCatalogue(sourceFetch.body, sourceFetch.finalUrl || job.url);
      const catalogue = await resolveCatalogueLinks(rawCatalogue, { concurrency: 20, timeout: 4500 }).catch(() => rawCatalogue);
      const isMoviePage = catalogue.type === 'movie';

      recordInCatalog({
        title: catalogue.title || '4KHub4U Content',
        url: job.url,
        format: isMoviePage ? 'Movie' : 'Series',
        platform: '4KHub4U',
      });

      const allReleases =
        catalogue.type === 'series' && Array.isArray(catalogue.seasons)
          ? catalogue.seasons.flatMap((s) => s.releases || [])
          : Array.isArray(catalogue.qualities)
          ? catalogue.qualities.flatMap((q) => q.releases || [])
          : [];

      let resolvedCount = 0;
      let totalLinksCount = 0;
      const unresolvedLinks = [];

      for (const rel of allReleases) {
        for (const dl of (rel.downloadLinks || [])) {
          totalLinksCount++;
          const rawLink = dl.url;
          const isDirectHubCloud = dl.isDirectDestination || isHubCloudDriveUrl(rawLink) || /hubcloud\.[a-z0-9.]+/i.test(rawLink);
          const providerUrl = isDirectHubCloud ? rawLink : null;
          const mediatorUrl = isDirectHubCloud ? null : rawLink;
          const fileId = isDirectHubCloud ? extractHubCloudDriveId(rawLink) : null;
          const status = isDirectHubCloud ? SCRAPED_STATUS.RESOLVED : SCRAPED_STATUS.DISCOVERED;
          if (isDirectHubCloud) resolvedCount++;

          const savedDoc = {
            sourceUrl: job.url,
            sourceDomain: new URL(job.url).hostname,
            title: rel.label || catalogue.title,
            filename: rel.filename || rel.label || catalogue.title,
            scope: rel.scope || (isMoviePage ? 'movie' : (rel.episode !== null && rel.episode !== undefined ? 'episode' : 'pack')),
            season: isMoviePage ? null : (rel.season ?? 1),
            episode: isMoviePage ? null : (rel.episode ?? null),
            quality: rel.quality?.normalized || rel.resolution || 'unknown',
            codec: rel.codec || null,
            sizeDisplay: rel.fileSize || null,
            provider: dl.provider || 'HUBCLOUD',
            providerUrl,
            mediatorUrl,
            fileId,
            status,
          };

          await scrapedLinksRepo.saveLink(savedDoc);

          if (!isDirectHubCloud && mediatorUrl) {
            unresolvedLinks.push({ rel, dl, doc: savedDoc });
          }
        }
      }

      // Browser fallback for any residual links that could not be resolved via HTTP inspection
      if (unresolvedLinks.length > 0 && config.browserScraperEnabled !== false) {
        logger.log('4KHub4U', `[4KHub4U] Attempting browser fallback for ${unresolvedLinks.length} unresolved mediator link(s)...`);
        try {
          const { resolveMediatorFlow } = await import('../resolvers/mediator/browser.js');
          const concurrencyLimit = Math.min(config.mediatorConcurrency || 1, unresolvedLinks.length);
          await runBoundedWithBrowser(
            unresolvedLinks.map(({ doc, dl }) => async (sharedBrowser) => {
              try {
                const res = await resolveMediatorFlow(dl.url, {
                  meta: doc,
                  countdownTimeout: 25000,
                  navigationTimeout: 15000,
                  existingBrowser: sharedBrowser,
                });
                if (res.success && res.destination && isHubCloudDriveUrl(res.destination)) {
                  resolvedCount++;
                  doc.providerUrl = res.destination;
                  doc.fileId = extractHubCloudDriveId(res.destination);
                  doc.status = SCRAPED_STATUS.RESOLVED;
                  await scrapedLinksRepo.saveLink(doc);
                }
              } catch (_) {}
            }),
            concurrencyLimit,
            { headless: true }
          );
        } catch (bErr) {
          logger.warning(`[4KHub4U] Browser fallback notice: ${bErr.message}`);
        }
      }

      logger.log('4KHub4U', `Job ${jobId} finished: ${allReleases.length} release(s), ${resolvedCount}/${totalLinksCount} direct HubCloud links resolved`);

      await jobsRepo.updateJob(jobId, {
        status: SCRAPED_STATUS.RESOLVED,
        extractedCount: resolvedCount || totalLinksCount,
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
