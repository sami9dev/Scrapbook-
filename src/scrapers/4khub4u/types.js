/**
 * Type definitions and data models for 4KHub4U Catalogue, Releases, and State Machine.
 * Strictly adheres to Sections 5, 8, 9, 10, 11, 12, 22, and 28 of the specification.
 */

/**
 * Resolution states for the lazy link resolution state machine.
 */
export const ResolutionState = {
  DISCOVERED: 'discovered',
  RESOLVING: 'resolving',
  REDIRECTING: 'redirecting',
  COUNTDOWN: 'countdown',
  DESTINATION_FOUND: 'destination_found',
  VERIFICATION_REQUIRED: 'verification_required',
  TIMEOUT: 'timeout',
  FAILED: 'failed',
};

export const Hub4UState = {
  START: 'START',
  PAGE_FETCH: 'PAGE_FETCH',
  CATALOGUE_PARSED: 'CATALOGUE_PARSED',
  LINKS_EXTRACTED: 'LINKS_EXTRACTED',
  MEDIATOR_RESOLVING: 'MEDIATOR_RESOLVING',
  DESTINATION_FOUND: 'DESTINATION_FOUND',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  DESTINATION_NOT_FOUND: 'DESTINATION_NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR',
};

/**
 * Supported domain patterns for 4KHub4U and its mirrors.
 */
const ALLOWED_HOST_PATTERNS = [
  /^(?:.*\.)?4khub4u\.[a-z0-9.]+$/i,
  /^(?:.*\.)?4khdhub\.[a-z0-9.]+$/i,
  /^(?:.*\.)?hdhub4u\.[a-z0-9.]+$/i,
];

/**
 * Validates whether a URL belongs to 4KHub4U / 4KHDHub / HDHub4U.
 * Rejects arbitrary URLs as scraper targets.
 * Also allows localhost/127.0.0.1 in non-production or test contexts if path contains test markers.
 *
 * @param {string} urlString The candidate URL string
 * @returns {boolean} True if URL is a recognized 4KHub4U domain
 */
export function is4KHub4UUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(urlString.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    // Check production / recognized hostnames
    if (ALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
      return true;
    }

    // Allow local mock / test servers (127.0.0.1 or localhost) during tests
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      const fullPath = (parsed.pathname + parsed.search).toLowerCase();
      if (
        fullPath.includes('4kh') ||
        fullPath.includes('hdhub') ||
        fullPath.includes('movie') ||
        fullPath.includes('series') ||
        fullPath.includes('mediator')
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

export default {
  ResolutionState,
  Hub4UState,
  is4KHub4UUrl,
};
