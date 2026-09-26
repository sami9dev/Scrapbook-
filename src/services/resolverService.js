import { extract4KHDHubLinks } from '../providers/4khdhub/extractor.js';
import { resolveMediatorFlow } from '../resolvers/mediator/browser.js';
import { logger } from '../logging/logger.js';
import { fetchWithControls } from '../discovery/http-client.js';

async function getPageHtml(url) {
  try {
    const res = await fetchWithControls(url);
    if (res && res.body) return res.body;
  } catch (err) {
    logger.warning(`fetchWithControls fallback to global fetch: ${err.message}`);
  }
  const res = await fetch(url);
  return await res.text();
}

export class ResolverService {
  /**
   * @param {object} [options]
   * @param {number} [options.maxRetries] Default 3 (Section 20)
   * @param {number} [options.retryDelayMs] Default 1500
   */
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.retryDelayMs = options.retryDelayMs || 1500;
    // In-memory cache keyed by sourceContentId + quality + provider (Section 19)
    this.cache = new Map();
  }

  getCacheKey(sourceUrl, quality, episode = null) {
    return `${sourceUrl}::${quality}::${episode || 'all'}`;
  }

  /**
   * Resolves links from a 4KHDHub source URL or raw HTML.
   * 
   * @param {object} params
   * @param {string} [params.url] Source 4KHDHub URL
   * @param {string} [params.html] Raw source HTML (if provided directly)
   * @param {string} [params.targetQuality] 'all', '2160p', '1080p', '720p', '480p'
   * @param {number} [params.targetEpisode] Specific episode number if applicable
   * @param {boolean} [params.resolveMediators] If true, runs the browser mediator flow to get final HubCloud URLs
   * @param {object} [params.browserOptions] Options passed to Playwright
   * @returns {Promise<{
   *   title: string,
   *   sourceUrl: string,
   *   links: Array<{
   *     title: string,
   *     season: number|null,
   *     episode: number|null,
   *     quality: string,
   *     language: string|null,
   *     provider: string,
   *     mediatorUrl: string,
   *     destinationUrl: string|null,
   *     status: string,
   *     error: string|null,
   *     elapsedMs?: number
   *   }>
   * }>}
   */
  async resolveSource({
    url = '',
    html = null,
    targetQuality = 'all',
    targetEpisode = null,
    resolveMediators = false,
    browserOptions = {},
  } = {}) {
    let sourceHtml = html;

    // Fetch page HTML if not provided directly
    if (!sourceHtml && url) {
      logger.discovered(`Fetching 4KHDHub page: ${url}`);
      sourceHtml = await getPageHtml(url);
    }

    if (!sourceHtml) {
      throw new Error('No HTML content or valid source URL provided.');
    }

    // 1. Extract 4KHDHub content and dynamic HubCloud buttons
    const extracted = extract4KHDHubLinks(sourceHtml, url);
    logger.parsing(`Found ${extracted.links.length} HubCloud button(s) for "${extracted.title}"`);

    // 2. Filter by quality and/or episode if specified
    let filteredLinks = extracted.links;

    if (targetQuality && targetQuality !== 'all') {
      const qNorm = targetQuality.toLowerCase().replace(/p$/, '');
      filteredLinks = filteredLinks.filter((l) => (
        l.quality && l.quality.toLowerCase().replace(/p$/, '') === qNorm
      ));
    }

    if (targetEpisode !== null && targetEpisode !== undefined) {
      filteredLinks = filteredLinks.filter((l) => l.episode === targetEpisode);
    }

    // 3. Resolve through mediators if requested
    const results = [];

    for (const item of filteredLinks) {
      const cacheKey = this.getCacheKey(item.sourceUrl, item.quality, item.episode);
      if (this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        // Only return cache if not expired (1 hour TTL)
        if (Date.now() - cached.timestamp < 3600000) {
          logger.log('CACHE', `Returning cached HubCloud destination for ${cacheKey}`);
          results.push({ ...item, ...cached.data });
          continue;
        }
      }

      if (!resolveMediators) {
        // Only extraction requested
        results.push({
          ...item,
          destinationUrl: null,
          status: 'UNRESOLVED_MEDIATOR',
          error: null,
        });
        continue;
      }

      // Execute mediator resolution with retry policy (Section 20)
      let resolutionResult = null;
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        logger.log('RESOLVER', `Resolving mediator for [${item.quality}] "${item.title}" (Attempt ${attempt}/${this.maxRetries})`);
        
        resolutionResult = await resolveMediatorFlow(item.mediatorUrl, {
          meta: item,
          ...browserOptions,
        });

        if (resolutionResult.success) {
          break;
        }

        // Do NOT retry if human verification is required (Section 14 & 20)
        if (resolutionResult.state === 'CAPTCHA_REQUIRED') {
          break;
        }

        if (attempt < this.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
        }
      }

      const itemResult = {
        ...item,
        destinationUrl: resolutionResult?.destination || null,
        status: resolutionResult?.state || 'FAILED',
        error: resolutionResult?.error || null,
        elapsedMs: resolutionResult?.elapsedMs || 0,
      };

      if (resolutionResult?.success) {
        this.cache.set(cacheKey, {
          timestamp: Date.now(),
          data: {
            destinationUrl: itemResult.destinationUrl,
            status: itemResult.status,
            error: null,
          },
        });
      }

      results.push(itemResult);
    }

    return {
      title: extracted.title,
      sourceUrl: url,
      links: results,
    };
  }
}

export const resolverService = new ResolverService();
export default resolverService;
