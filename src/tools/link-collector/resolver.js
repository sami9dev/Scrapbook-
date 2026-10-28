import * as cheerio from 'cheerio';
import { logger } from '../../logging/logger.js';

/**
 * Resolves a URL through its standard HTTP redirect chain, recording final destination, status, and title.
 */
export class LinkResolver {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs] Request timeout in milliseconds (default 10000).
   * @param {number} [options.maxRedirects] Maximum number of redirects to follow (default 5).
   * @param {string} [options.userAgent] User-Agent string.
   */
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || 10000;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.userAgent = options.userAgent || 'LinkCollectorBot/1.0 (+https://example.com/bot)';
  }

  /**
   * Resolves a URL to its final destination by following HTTP redirects.
   *
   * @param {string} originalUrl
   * @returns {Promise<{
   *   originalUrl: string,
   *   finalUrl: string,
   *   httpStatus: number,
   *   pageTitle: string,
   *   redirectCount: number,
   *   redirectChain: string[],
   *   contentType: string,
   *   error: string | null
   * }>}
   */
  async resolve(originalUrl) {
    let currentUrl = originalUrl;
    const redirectChain = [originalUrl];
    const visited = new Set([originalUrl]);
    let redirectCount = 0;
    let lastStatus = 0;
    let finalContentType = '';
    let pageTitle = '';

    while (redirectCount <= this.maxRedirects) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      let response;
      try {
        // Use GET with manual redirect to trace every hop precisely
        response = await fetch(currentUrl, {
          method: 'GET',
          headers: {
            'User-Agent': this.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const errorMsg = err.name === 'AbortError'
          ? `Timeout after ${this.timeoutMs}ms`
          : `Network error: ${err.message}`;

        return {
          originalUrl,
          finalUrl: currentUrl,
          httpStatus: lastStatus,
          pageTitle: '',
          redirectCount,
          redirectChain,
          contentType: '',
          error: errorMsg,
        };
      } finally {
        clearTimeout(timer);
      }

      lastStatus = response.status;
      finalContentType = response.headers.get('content-type') || '';

      // Check for redirect status codes (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(lastStatus)) {
        const location = response.headers.get('location');
        if (!location) {
          return {
            originalUrl,
            finalUrl: currentUrl,
            httpStatus: lastStatus,
            pageTitle: '',
            redirectCount,
            redirectChain,
            contentType: finalContentType,
            error: 'Redirect status received without Location header',
          };
        }

        try {
          const nextUrl = new URL(location, currentUrl).href;
          if (visited.has(nextUrl)) {
            return {
              originalUrl,
              finalUrl: nextUrl,
              httpStatus: lastStatus,
              pageTitle: '',
              redirectCount,
              redirectChain,
              contentType: finalContentType,
              error: `Redirect loop detected: ${nextUrl}`,
            };
          }

          redirectCount++;
          if (redirectCount > this.maxRedirects) {
            return {
              originalUrl,
              finalUrl: nextUrl,
              httpStatus: lastStatus,
              pageTitle: '',
              redirectCount,
              redirectChain,
              contentType: finalContentType,
              error: `Exceeded maximum redirect limit (${this.maxRedirects})`,
            };
          }

          visited.add(nextUrl);
          redirectChain.push(nextUrl);
          currentUrl = nextUrl;
          continue;
        } catch {
          return {
            originalUrl,
            finalUrl: currentUrl,
            httpStatus: lastStatus,
            pageTitle: '',
            redirectCount,
            redirectChain,
            contentType: finalContentType,
            error: `Invalid Location header URL: ${location}`,
          };
        }
      }

      // Reached final non-redirect response
      // Extract title if HTML
      if (finalContentType.includes('text/html')) {
        try {
          const bodyText = await response.text();
          const $ = cheerio.load(bodyText.slice(0, 200000)); // Sample first 200KB for title
          pageTitle = $('title').first().text().replace(/\s+/g, ' ').trim() || '';

          // Ethical check: Note if page is behind login or challenge without attempting bypass
          if (lastStatus === 401) {
            pageTitle = pageTitle || 'Authentication Required (401)';
          } else if (lastStatus === 403) {
            pageTitle = pageTitle || 'Access Forbidden (403)';
          } else if (
            /captcha|turnstile|attention required|just a moment/i.test(pageTitle) ||
            /cf-turnstile|g-recaptcha/i.test(bodyText.slice(0, 50000))
          ) {
            pageTitle = `[Verification/Challenge] ${pageTitle}`;
          }
        } catch {
          // Body reading failed
        }
      }

      return {
        originalUrl,
        finalUrl: currentUrl,
        httpStatus: lastStatus,
        pageTitle,
        redirectCount,
        redirectChain,
        contentType: finalContentType,
        error: lastStatus >= 400 ? `HTTP ${lastStatus}` : null,
      };
    }

    return {
      originalUrl,
      finalUrl: currentUrl,
      httpStatus: lastStatus,
      pageTitle,
      redirectCount,
      redirectChain,
      contentType: finalContentType,
      error: 'Exceeded redirect limit',
    };
  }
}
