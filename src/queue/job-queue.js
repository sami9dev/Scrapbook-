import { config } from '../config/config.js';
import { logger } from '../logging/logger.js';
import { fetchWithControls } from '../discovery/http-client.js';
import { scrapedLinksRepo, jobsRepo, SCRAPED_STATUS } from '../database/models.js';
import { runBoundedWithBrowser } from '../utils/concurrency.js';

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

    // Step 1: Fetch Source Page for 4KHub4U
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
          const rawLink = dl.url;
          // STRICT FILTER: Discard any HubDrive links; only HubCloud is supported
          if (!rawLink || /hubdrive/i.test(dl.provider || '') || /hubdrive/i.test(rawLink)) {
            continue;
          }
          totalLinksCount++;
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
            provider: 'HubCloud',
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

    // Only 4KHub4U is supported
    logger.warning(`Job ${jobId} rejected: Only 4KHub4U / 4KHDHub URLs are supported.`);
    await jobsRepo.updateJob(jobId, {
      status: SCRAPED_STATUS.ERROR,
      error: 'Only 4KHub4U / 4KHDHub URLs are supported.',
    });
    return;

  }
}

export const jobQueue = new JobQueue();
export default jobQueue;
