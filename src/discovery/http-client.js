import { resolveRedirects } from './redirect-resolver.js';
import { detectHumanVerificationChallenge } from '../parsing/html-parser.js';
import { logger } from '../logging/logger.js';
import { config } from '../config/config.js';

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 405]);

/**
 * Sleep helper for backoff delays.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP client that resolves redirects, enforces timeouts, detects human-verification challenges,
 * and handles exponential backoff retries for transient HTTP errors.
 * 
 * @param {string} url - Target URL to fetch
 * @param {object} options
 * @param {number} [options.maxRetries]
 * @param {number[]} [options.backoffDelays]
 * @param {number} [options.timeout]
 * @param {number} [options.maxRedirects]
 * @param {string[]} [options.allowedDomains]
 * @param {boolean} [options.allowInternal]
 * @param {Function} [options.fetchFn]
 * @returns {Promise<{
 *   success: boolean,
 *   status: number,
 *   url: string,
 *   finalUrl: string,
 *   redirectChain: string[],
 *   body: string,
 *   headers: Headers,
 *   verificationRequired: boolean,
 *   challengeResult?: object,
 *   error?: string
 * }>}
 */
export async function fetchWithControls(url, options = {}) {
  const maxRetries = options.maxRetries ?? config.maxRetries;
  const backoffDelays = options.backoffDelays ?? config.backoffDelays;

  let attempt = 0;
  let lastError = null;

  while (attempt <= maxRetries) {
    try {
      logger.discovered(`Fetching URL (attempt ${attempt + 1}/${maxRetries + 1}): ${url}`);

      const result = await resolveRedirects(url, options);

      // Check for human verification challenge in response body FIRST (Cloudflare / Turnstile challenges return 403)
      const challengeCheck = detectHumanVerificationChallenge(result.body, result.finalUrl);
      if (challengeCheck.isChallenge) {
        logger.warning(`HUMAN_VERIFICATION_REQUIRED detected on ${result.finalUrl}. Halting automated flow without retrying.`);
        return {
          success: false,
          status: result.status,
          url,
          finalUrl: result.finalUrl,
          redirectChain: result.redirectChain,
          body: result.body,
          headers: result.response ? result.response.headers : new Headers(),
          verificationRequired: true,
          challengeResult: challengeCheck.result,
        };
      }

      // Check if response is non-retryable 401, 403, etc.
      if (NON_RETRYABLE_STATUS_CODES.has(result.status)) {
        logger.warning(`Non-retryable HTTP status [${result.status}] encountered for ${url}`);
        return {
          success: false,
          status: result.status,
          url,
          finalUrl: result.finalUrl,
          redirectChain: result.redirectChain,
          body: result.body,
          headers: result.response ? result.response.headers : new Headers(),
          verificationRequired: false,
          error: `HTTP ${result.status}: ${result.response ? result.response.statusText : 'Client Error'}`,
        };
      }

      // Check if status is a retryable server error (500, 502, 503, 504, 408, 429)
      if (RETRYABLE_STATUS_CODES.has(result.status)) {
        if (attempt < maxRetries) {
          const delay = backoffDelays[attempt] || 1000 * Math.pow(2, attempt);
          logger.warning(`Retryable HTTP status [${result.status}] on ${url}. Retrying in ${delay}ms...`);
          await sleep(delay);
          attempt++;
          continue;
        } else {
          return {
            success: false,
            status: result.status,
            url,
            finalUrl: result.finalUrl,
            redirectChain: result.redirectChain,
            body: result.body,
            headers: result.response ? result.response.headers : new Headers(),
            verificationRequired: false,
            error: `HTTP ${result.status} after ${maxRetries + 1} attempts`,
          };
        }
      }

      // Successful 2xx or other normal status
      return {
        success: result.status >= 200 && result.status < 300,
        status: result.status,
        url,
        finalUrl: result.finalUrl,
        redirectChain: result.redirectChain,
        body: result.body,
        headers: result.response ? result.response.headers : new Headers(),
        verificationRequired: false,
      };
    } catch (err) {
      lastError = err;

      // Do NOT retry security blocks or redirect limit exceeded
      if (err.status === 'ACCESS_DENIED' || err.status === 'REDIRECT_LIMIT_EXCEEDED') {
        logger.error(`Critical request error [${err.status}]: ${err.message}`);
        return {
          success: false,
          status: 0,
          url,
          finalUrl: url,
          redirectChain: err.details?.redirectChain || [],
          body: '',
          verificationRequired: false,
          error: err.message,
          errorStatus: err.status,
        };
      }

      // Retry transient network errors if attempts remain
      if (attempt < maxRetries) {
        const delay = backoffDelays[attempt] || 1000 * Math.pow(2, attempt);
        logger.warning(`Request error (${err.message}) on ${url}. Retrying in ${delay}ms...`);
        await sleep(delay);
        attempt++;
      } else {
        break;
      }
    }
  }

  logger.error(`Request failed after ${maxRetries + 1} attempts: ${lastError?.message}`);
  return {
    success: false,
    status: 0,
    url,
    finalUrl: url,
    redirectChain: [],
    body: '',
    verificationRequired: false,
    error: lastError ? lastError.message : 'Unknown request failure',
  };
}
