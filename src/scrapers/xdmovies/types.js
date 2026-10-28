/**
 * Type definitions, constants, and URL validator for the XDMovies scraper.
 */

/**
 * Resolution states for the XDMovies scraper flow.
 */
export const XDMoviesState = {
  START: 'START',
  PAGE_FETCH: 'PAGE_FETCH',
  CATALOGUE_PARSED: 'CATALOGUE_PARSED',
  DESTINATION_FOUND: 'DESTINATION_FOUND',
  DESTINATION_NOT_FOUND: 'DESTINATION_NOT_FOUND',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR',
};

/**
 * Known XDMovies domain patterns (primary + common mirrors).
 */
const ALLOWED_HOST_PATTERNS = [
  /^(?:.*\.)?xdmovies\.[a-z0-9.]+$/i,
  /^(?:.*\.)?top\.xdmovies\.[a-z0-9.]+$/i,
  /^(?:.*\.)?xdmoviez\.[a-z0-9.]+$/i,
];

/**
 * Validates whether a URL belongs to the XDMovies network.
 * Also permits localhost/127.0.0.1 for test fixtures.
 *
 * @param {string} urlString
 * @returns {boolean}
 */
export function isXDMoviesUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return false;

  try {
    const parsed = new URL(urlString.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname.toLowerCase();

    if (ALLOWED_HOST_PATTERNS.some((p) => p.test(hostname))) return true;

    // Allow local test servers
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      const fullPath = (parsed.pathname + parsed.search).toLowerCase();
      if (fullPath.includes('xdmovie') || fullPath.includes('movie') || fullPath.includes('series')) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Validates whether a URL is an XDMovies mediator URL (link.xdmovies or latestnewsonline).
 *
 * @param {string} urlString
 * @returns {boolean}
 */
export function isXDMoviesMediatorUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return false;
  return /link\.xdmovies\.[a-z0-9.]+|latestnewsonline\.[a-z0-9.]+/i.test(urlString);
}

export default { XDMoviesState, isXDMoviesUrl, isXDMoviesMediatorUrl };
