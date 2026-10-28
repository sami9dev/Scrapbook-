/**
 * XDMovies Resolver
 *
 * Resolves an XDMovies movie, TV series, or mediator download link into
 * its full release catalogue and final HubCloud destination URL.
 * Automatically clears Cloudflare Turnstile verification challenges.
 */

import { logger } from '../../logging/logger.js';
import { parseXDMoviesCatalogue } from './catalogue.js';
import { fetchXDMoviesPage } from './browser-fetch.js';
import { resolveXDMoviesMediator, canonicalHubCloudUrl } from './mediator.js';
import { isHubCloudDriveUrl, fetchHubCloudMetadata } from '../../providers/hubcloud/validator.js';
import { matchesQuality } from '../../utils/normalize.js';
import { isXDMoviesUrl, isXDMoviesMediatorUrl, XDMoviesState } from './types.js';

/**
 * Resolves an XDMovies URL to a parsed release catalogue and/or HubCloud destination.
 *
 * @param {string} url - The XDMovies page, mediator link, or HubCloud drive URL
 * @param {object} [options]
 * @param {boolean} [options.resolveDestination=true] - Whether to resolve mediator links into final HubCloud destination
 * @param {string} [options.targetQuality] - Target quality filter ('1080p', '720p', etc.)
 * @param {string} [options.targetScope] - Target scope filter ('movie', 'episode', 'pack')
 * @param {number} [options.episodeNumber] - Target episode number
 * @param {number} [options.seasonNumber] - Target season number
 * @param {boolean} [options.headless=false] - Headless browser mode
 * @param {number} [options.timeoutMs=45000] - Navigation timeout
 * @param {number} [options.requestReceivedAt] - Timestamp when request arrived
 * @returns {Promise<{
 *   success: boolean,
 *   state: string,
 *   title: string,
 *   type: 'movie' | 'series',
 *   provider: string,
 *   sourceUrl: string,
 *   mediatorUrl: string | null,
 *   destination: string | null,
 *   metadata: object | null,
 *   catalogue: object | null,
 *   error: string | null,
 *   elapsedMs: number,
 *   metrics: object
 * }>}
 */
export async function resolveXDMovies(url, options = {}) {
  const requestReceivedAt = options.requestReceivedAt || Date.now();
  const resolverStartedAt = Date.now();

  const makeMetrics = (finishedAt) => ({
    requestReceivedAt,
    resolverStartedAt,
    resolverFinishedAt: finishedAt,
    resolverDurationMs: finishedAt - resolverStartedAt,
    totalDurationMs: finishedAt - requestReceivedAt,
  });

  const normalizedUrl = (url || '').trim();

  // Case A: Direct HubCloud Drive URL
  if (isHubCloudDriveUrl(normalizedUrl)) {
    const canonical = canonicalHubCloudUrl(normalizedUrl);
    let metadata = null;
    try {
      metadata = await fetchHubCloudMetadata(canonical);
    } catch {}
    const finishedAt = Date.now();
    return {
      success: true,
      state: XDMoviesState.DESTINATION_FOUND,
      title: metadata?.filename || metadata?.title || 'HubCloud Destination Link',
      type: 'movie',
      provider: 'HubCloud',
      sourceUrl: normalizedUrl,
      mediatorUrl: null,
      destination: canonical,
      metadata,
      catalogue: null,
      error: null,
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: makeMetrics(finishedAt),
    };
  }

  // Case B: Direct mediator link (link.xdmovies.wtf or latestnewsonline.sbs)
  if (isXDMoviesMediatorUrl(normalizedUrl)) {
    logger.discovered(`[XDMovies] Resolving direct mediator link: ${normalizedUrl}`);
    const medResult = await resolveXDMoviesMediator(normalizedUrl, {
      headless: options.headless !== undefined ? options.headless : false,
      timeoutMs: options.timeoutMs || 45000,
    });
    const finishedAt = Date.now();
    return {
      success: medResult.success,
      state: medResult.success ? XDMoviesState.DESTINATION_FOUND : XDMoviesState.ERROR,
      title: medResult.metadata?.filename || medResult.metadata?.title || 'XDMovies Content',
      type: 'movie',
      provider: 'HubCloud',
      sourceUrl: normalizedUrl,
      mediatorUrl: normalizedUrl,
      destination: medResult.destination,
      metadata: medResult.metadata,
      catalogue: null,
      error: medResult.error,
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: makeMetrics(finishedAt),
    };
  }

  // Case C: Hostname validation for content page
  if (!isXDMoviesUrl(normalizedUrl)) {
    const finishedAt = Date.now();
    return {
      success: false,
      state: XDMoviesState.ERROR,
      title: 'Unknown Title',
      type: 'movie',
      provider: 'HubCloud',
      sourceUrl: normalizedUrl,
      mediatorUrl: null,
      destination: null,
      metadata: null,
      catalogue: null,
      error: 'Invalid URL. Only recognized XDMovies domain URLs or mediator links are accepted.',
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: makeMetrics(finishedAt),
    };
  }

  // Fetch page HTML through browser (handles Cloudflare Turnstile & SPA rendering)
  logger.discovered(`[XDMovies] Resolving catalogue for: ${normalizedUrl}`);
  const fetchResult = await fetchXDMoviesPage(normalizedUrl, {
    headless: options.headless !== undefined ? options.headless : false,
    timeoutMs: options.timeoutMs || 35000,
  });

  if (!fetchResult.success || !fetchResult.html) {
    const finishedAt = Date.now();
    return {
      success: false,
      state: XDMoviesState.ERROR,
      title: 'Unknown Title',
      type: 'movie',
      provider: 'HubCloud',
      sourceUrl: normalizedUrl,
      mediatorUrl: null,
      destination: null,
      metadata: null,
      catalogue: null,
      error: fetchResult.error || 'Failed to fetch XDMovies page HTML.',
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: makeMetrics(finishedAt),
    };
  }

  // Check if Cloudflare challenge was not cleared
  if (
    fetchResult.html.includes('Just a moment...') &&
    !fetchResult.html.includes('download-item') &&
    !fetchResult.html.includes('episode-card')
  ) {
    const finishedAt = Date.now();
    return {
      success: false,
      state: XDMoviesState.VERIFICATION_REQUIRED,
      title: 'Unknown Title',
      type: 'movie',
      provider: 'HubCloud',
      sourceUrl: normalizedUrl,
      mediatorUrl: null,
      destination: null,
      metadata: null,
      catalogue: null,
      error: 'Human verification required on XDMovies source page.',
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: makeMetrics(finishedAt),
    };
  }

  // Parse catalogue
  let catalogue;
  try {
    catalogue = parseXDMoviesCatalogue(fetchResult.html, fetchResult.finalUrl || normalizedUrl);
  } catch (parseErr) {
    const finishedAt = Date.now();
    return {
      success: false,
      state: XDMoviesState.ERROR,
      title: 'Unknown Title',
      type: 'movie',
      provider: 'HubCloud',
      sourceUrl: normalizedUrl,
      mediatorUrl: null,
      destination: null,
      metadata: null,
      catalogue: null,
      error: `Catalogue parse error: ${parseErr.message}`,
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: makeMetrics(finishedAt),
    };
  }

  if (!catalogue || catalogue.totalLinks === 0) {
    const finishedAt = Date.now();
    return {
      success: false,
      state: XDMoviesState.DESTINATION_NOT_FOUND,
      title: catalogue?.title || 'Unknown Title',
      type: catalogue?.type || 'movie',
      provider: 'HubCloud',
      sourceUrl: normalizedUrl,
      mediatorUrl: null,
      destination: null,
      metadata: null,
      catalogue,
      error: 'No download links found on the XDMovies page.',
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: makeMetrics(finishedAt),
    };
  }

  logger.log(
    'XDMovies',
    `[XDMovies] Successfully resolved "${catalogue.title}" (${catalogue.type}) — ${catalogue.totalReleases} releases, ${catalogue.totalLinks} links`
  );

  // If destination resolution is disabled, return catalogue directly
  const shouldResolveDestination = options.resolveDestination !== false;
  if (!shouldResolveDestination) {
    const finishedAt = Date.now();
    return {
      success: true,
      state: XDMoviesState.CATALOGUE_PARSED,
      title: catalogue.title,
      type: catalogue.type,
      provider: 'HubCloud',
      sourceUrl: normalizedUrl,
      mediatorUrl: null,
      destination: null,
      metadata: null,
      catalogue,
      error: null,
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: makeMetrics(finishedAt),
    };
  }

  // Select target release candidate based on options (targetQuality, targetScope, episodeNumber)
  let candidateReleases = [];
  for (const q of catalogue.qualities) {
    for (const rel of q.releases) {
      if (rel.downloadLinks && rel.downloadLinks.length > 0) {
        candidateReleases.push(rel);
      }
    }
  }

  if (options.targetQuality && options.targetQuality !== 'all') {
    const filtered = candidateReleases.filter((r) => matchesQuality(r.resolution, options.targetQuality));
    if (filtered.length > 0) candidateReleases = filtered;
  }

  if (options.targetScope && options.targetScope !== 'all') {
    const filtered = candidateReleases.filter((r) => r.scope === options.targetScope);
    if (filtered.length > 0) candidateReleases = filtered;
  }

  if (options.episodeNumber !== undefined) {
    const filtered = candidateReleases.filter((r) => r.episodeNumber === Number(options.episodeNumber));
    if (filtered.length > 0) candidateReleases = filtered;
  }

  const selectedRelease = candidateReleases[0] || null;
  const targetLink = selectedRelease?.downloadLinks?.[0]?.url || null;

  if (!targetLink) {
    const finishedAt = Date.now();
    return {
      success: false,
      state: XDMoviesState.DESTINATION_NOT_FOUND,
      title: catalogue.title,
      type: catalogue.type,
      provider: 'HubCloud',
      sourceUrl: normalizedUrl,
      mediatorUrl: null,
      destination: null,
      metadata: null,
      catalogue,
      error: 'No valid candidate download link found matching criteria.',
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: makeMetrics(finishedAt),
    };
  }

  logger.log(
    'XDMovies',
    `[XDMovies] Resolving HubCloud destination for candidate: "${selectedRelease.label}" (${targetLink})`
  );

  const medResolution = await resolveXDMoviesMediator(targetLink, {
    headless: options.headless !== undefined ? options.headless : false,
    timeoutMs: options.timeoutMs || 45000,
  });

  const finishedAt = Date.now();

  if (!medResolution.success || !medResolution.destination) {
    return {
      success: false,
      state: XDMoviesState.ERROR,
      title: catalogue.title,
      type: catalogue.type,
      provider: 'HubCloud',
      sourceUrl: normalizedUrl,
      mediatorUrl: targetLink,
      destination: null,
      metadata: null,
      catalogue,
      error: medResolution.error || 'Failed to resolve mediator link into HubCloud destination.',
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: makeMetrics(finishedAt),
    };
  }

  return {
    success: true,
    state: XDMoviesState.DESTINATION_FOUND,
    title: medResolution.metadata?.filename || catalogue.title,
    type: catalogue.type,
    provider: 'HubCloud',
    sourceUrl: normalizedUrl,
    mediatorUrl: targetLink,
    destination: medResolution.destination,
    metadata: medResolution.metadata,
    catalogue,
    error: null,
    elapsedMs: finishedAt - resolverStartedAt,
    metrics: makeMetrics(finishedAt),
  };
}

export default { resolveXDMovies };
