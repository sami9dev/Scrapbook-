import { validateUrl, resolveRelativeUrl } from '../utils/url.js';
import { logger } from '../logging/logger.js';
import { config } from '../config/config.js';

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Custom error for redirect limit exceeded.
 */
export class RedirectLimitExceededError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RedirectLimitExceededError';
    this.status = 'REDIRECT_LIMIT_EXCEEDED';
    this.details = details;
  }
}

/**
 * Resolves HTTP redirects manually while tracking the full redirect chain,
 * enforcing MAX_REDIRECTS, preventing redirect loops, and validating each hop against SSRF.
 * 
 * @param {string} initialUrl - Starting URL
 * @param {object} options
 * @param {number} [options.maxRedirects] - Max redirects allowed (default: config.maxRedirects)
 * @param {number} [options.timeout] - Timeout in ms (default: config.requestTimeout)
 * @param {string} [options.userAgent] - User agent (default: config.userAgent)
 * @param {string[]} [options.allowedDomains] - Domain allowlist
 * @param {boolean} [options.allowInternal] - For testing only
 * @param {Function} [options.fetchFn] - Custom fetch function for unit tests
 * @returns {Promise<{ originalUrl: string, redirectChain: string[], finalUrl: string, response: Response, status: number, body: string }>}
 */
export async function resolveRedirects(initialUrl, options = {}) {
  const maxRedirects = options.maxRedirects ?? config.maxRedirects;
  const timeoutMs = options.timeout ?? config.requestTimeout;
  const userAgent = options.userAgent ?? config.userAgent;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  // Validate initial URL
  const initialCheck = validateUrl(initialUrl, {
    allowedDomains: options.allowedDomains ?? config.allowedDomains,
    allowInternal: options.allowInternal ?? false,
  });

  if (!initialCheck.valid) {
    throw new Error(`Invalid initial URL: ${initialCheck.error}`);
  }

  let currentUrl = initialCheck.normalizedUrl;
  const originalUrl = currentUrl;
  const redirectChain = [];
  const visitedUrls = new Set([currentUrl]);

  let response = null;
  let body = '';

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    // Perform manual redirect request
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      response = await fetchFn(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        const timeoutErr = new Error(`Request timed out after ${timeoutMs}ms: ${currentUrl}`);
        timeoutErr.status = 'TIMEOUT';
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Check if this response is an HTTP redirect (301, 302, 303, 307, 308)
    if (REDIRECT_STATUS_CODES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        // Redirection status but no location header; treat as final
        body = await response.text();
        break;
      }

      // Resolve relative redirect against current URL
      const nextUrl = resolveRelativeUrl(currentUrl, location);
      if (!nextUrl) {
        throw new Error(`Failed to resolve redirect Location '${location}' against '${currentUrl}'`);
      }

      // Validate target redirect against SSRF and allowlists
      const nextCheck = validateUrl(nextUrl, {
        allowedDomains: options.allowedDomains ?? config.allowedDomains,
        allowInternal: options.allowInternal ?? false,
      });

      if (!nextCheck.valid) {
        const secErr = new Error(`Redirect blocked: ${nextCheck.error}`);
        secErr.status = 'ACCESS_DENIED';
        throw secErr;
      }

      const validNextUrl = nextCheck.normalizedUrl;

      // Detect circular redirect loops
      if (visitedUrls.has(validNextUrl)) {
        throw new RedirectLimitExceededError(`Redirect loop detected: '${validNextUrl}' already visited in chain`, {
          originalUrl,
          redirectChain,
          loopTarget: validNextUrl,
        });
      }

      // Check if redirect limit is reached
      if (redirectCount >= maxRedirects) {
        throw new RedirectLimitExceededError(`Maximum redirect limit of ${maxRedirects} exceeded`, {
          originalUrl,
          redirectChain,
          lastAttempted: validNextUrl,
        });
      }

      redirectChain.push(validNextUrl);
      visitedUrls.add(validNextUrl);

      logger.redirect(`Redirect [${response.status}]: ${currentUrl} -> ${validNextUrl}`);
      currentUrl = validNextUrl;
    } else {
      // Non-redirect response reached
      body = await response.text();
      break;
    }
  }

  return {
    originalUrl,
    redirectChain,
    finalUrl: currentUrl,
    response,
    status: response ? response.status : 0,
    body,
  };
}
