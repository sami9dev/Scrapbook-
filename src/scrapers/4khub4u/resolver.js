/**
 * 4KHub4U Resolver
 *
 * Single source of truth for resolving 4KHub4U / 4KHDHub pages into final HubCloud destinations.
 * Reuses the existing 4KHDHub extractor, mediator flow, and validator implementations.
 * Strictly adheres to non-bypass rules for human verification / Turnstile.
 */

import { extract4KHDHubLinks } from '../../providers/4khdhub/extractor.js';
import { resolveMediatorFlow } from '../../resolvers/mediator/browser.js';
import { resolveMediatorHttpFirst } from '../../resolvers/mediator/http-first.js';
import { isHubCloudDriveUrl, fetchHubCloudMetadata } from '../../providers/hubcloud/validator.js';
import { fetchWithControls } from '../../discovery/http-client.js';
import { detectHumanVerificationChallenge } from '../../parsing/html-parser.js';
import { logger } from '../../logging/logger.js';
import { matchesQuality } from '../../utils/normalize.js';
import { Hub4UState, is4KHub4UUrl } from './types.js';

/**
 * Resolves a 4KHub4U page URL to a legitimate HubCloud drive destination.
 * 
 * Flow:
 *   1. Validate hostname (must be 4KHub4U / 4KHDHub / HDHub4U)
 *   2. Fetch source page HTML & inspect for verification challenges
 *   3. Extract candidate download buttons and dynamic mediator URLs
 *   4. Resolve mediator through existing resolver (browser or HTTP-first)
 *   5. Return structured result with fine-grained performance metrics
 *
 * @param {string} url The 4KHub4U page URL
 * @param {object} [options] Resolution configuration options
 * @param {string} [options.targetQuality] Filter by quality ('1080p', '2160p', etc.)
 * @param {string} [options.targetScope] Filter by scope ('movie', 'episode', etc.)
 * @param {number} [options.countdownTimeout] Timeout waiting for countdown (ms)
 * @param {number} [options.navigationTimeout] Timeout waiting for navigation (ms)
 * @param {boolean} [options.headless] Headless browser execution
 * @param {import('playwright').Browser} [options.existingBrowser] Reused browser
 * @param {number} [options.requestReceivedAt] Timestamp when request arrived
 * @param {boolean} [options.useHttpFirst] Use HTTP-first optimization
 * @returns {Promise<{
 *   success: boolean,
 *   state: string,
 *   title: string,
 *   provider: string,
 *   destination: string|null,
 *   error: string|null,
 *   sourceUrl: string,
 *   mediatorUrl: string|null,
 *   elapsedMs: number,
 *   metrics: {
 *     requestReceivedAt: number,
 *     resolverStartedAt: number,
 *     resolverFinishedAt: number,
 *     telegramResponseStartedAt?: number,
 *     telegramResponseFinishedAt?: number,
 *     resolverDurationMs: number,
 *     telegramOverheadMs?: number,
 *     totalDurationMs: number
 *   },
 *   details?: object
 * }>}
 */
export async function resolve4KHub4U(url, options = {}) {
  const requestReceivedAt = options.requestReceivedAt || Date.now();
  const resolverStartedAt = Date.now();

  const createMetrics = (finishedAt) => ({
    requestReceivedAt,
    resolverStartedAt,
    resolverFinishedAt: finishedAt,
    resolverDurationMs: finishedAt - resolverStartedAt,
    totalDurationMs: finishedAt - requestReceivedAt,
  });

  const normalizedUrl = (url || '').trim();

  // Case A: User sent direct HubCloud Drive link
  if (isHubCloudDriveUrl(normalizedUrl)) {
    let fileTitle = 'HubCloud Destination Link';
    try {
      const hubMeta = await fetchHubCloudMetadata(normalizedUrl);
      if (hubMeta?.filename) fileTitle = hubMeta.filename;
    } catch {}

    const finishedAt = Date.now();
    return {
      success: true,
      state: Hub4UState.DESTINATION_FOUND,
      title: fileTitle,
      provider: 'HubCloud',
      destination: normalizedUrl,
      error: null,
      sourceUrl: normalizedUrl,
      mediatorUrl: null,
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: createMetrics(finishedAt),
      details: { filename: fileTitle },
    };
  }

  // Case B: Direct mediator link (e.g. greenmotors, fast-share, ?id=...)
  const isDirectMediator = /greenmotors|fast-share|fastdl|mediator|\?id=/i.test(normalizedUrl);
  if (isDirectMediator) {
    const useHttpFirst = options.useHttpFirst !== false;
    const resolution = useHttpFirst
      ? await resolveMediatorHttpFirst(normalizedUrl, {
          countdownTimeout: options.countdownTimeout || 35000,
          navigationTimeout: options.navigationTimeout || 20000,
          headless: options.headless !== undefined ? options.headless : true,
          existingBrowser: options.existingBrowser,
        })
      : await resolveMediatorFlow(normalizedUrl, {
          countdownTimeout: options.countdownTimeout || 35000,
          navigationTimeout: options.navigationTimeout || 20000,
          headless: options.headless !== undefined ? options.headless : true,
          existingBrowser: options.existingBrowser,
        });

    const finishedAt = Date.now();
    const isTargetDest =
      resolution.destination &&
      (isHubCloudDriveUrl(resolution.destination) ||
        /hubdrive\.[a-z]+/i.test(resolution.destination) ||
        /^https?:\/\/[a-z0-9.-]+\/(?:drive|file)\/[a-z0-9_-]+/i.test(resolution.destination));

    if (resolution.success && isTargetDest) {
      return {
        success: true,
        state: Hub4UState.DESTINATION_FOUND,
        title: resolution.meta?.title || '4KHub4U Content',
        provider: /hubdrive/i.test(resolution.destination) ? 'HubDrive' : 'HubCloud',
        destination: resolution.destination,
        error: null,
        sourceUrl: normalizedUrl,
        mediatorUrl: normalizedUrl,
        elapsedMs: finishedAt - resolverStartedAt,
        metrics: createMetrics(finishedAt),
        details: {
          filename: resolution.meta?.filename || resolution.meta?.title,
          browserMs: resolution.timings?.browserMs,
          httpMs: resolution.timings?.httpMs,
        },
      };
    }

    if (resolution.state === 'CAPTCHA_REQUIRED') {
      return {
        success: false,
        state: Hub4UState.VERIFICATION_REQUIRED,
        title: 'Unknown Title',
        provider: 'HubCloud',
        destination: null,
        error: resolution.error || 'Human verification required',
        sourceUrl: normalizedUrl,
        mediatorUrl: normalizedUrl,
        elapsedMs: finishedAt - resolverStartedAt,
        metrics: createMetrics(finishedAt),
      };
    }

    return {
      success: false,
      state: resolution.state === 'TIMEOUT' ? Hub4UState.TIMEOUT : Hub4UState.DESTINATION_NOT_FOUND,
      title: 'Unknown Title',
      provider: 'HubCloud',
      destination: null,
      error: resolution.error || 'Failed to resolve mediator into HubCloud destination',
      sourceUrl: normalizedUrl,
      mediatorUrl: normalizedUrl,
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: createMetrics(finishedAt),
    };
  }

  // 1. Hostname validation — strictly reject non-4KHub4U targets
  if (!is4KHub4UUrl(normalizedUrl)) {
    const finishedAt = Date.now();
    return {
      success: false,
      state: Hub4UState.ERROR,
      title: 'Unknown Title',
      provider: 'HubCloud',
      destination: null,
      error: 'Invalid URL. Only 4KHub4U / 4KHDHub / HDHub4U URLs are accepted.',
      sourceUrl: normalizedUrl,
      mediatorUrl: null,
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: createMetrics(finishedAt),
    };
  }

  // Case C: Standard 4KHub4U content page
  logger.discovered(`Fetching 4KHub4U content page: ${normalizedUrl}`);
  let sourceHtml = '';
  let finalUrl = normalizedUrl;

  try {
    const isLocal = normalizedUrl.includes('127.0.0.1') || normalizedUrl.includes('localhost');
    const sourceFetch = await fetchWithControls(normalizedUrl, {
      allowInternal: isLocal,
      maxRetries: isLocal ? 0 : undefined,
    });
    if (sourceFetch.verificationRequired) {
      const finishedAt = Date.now();
      return {
        success: false,
        state: Hub4UState.VERIFICATION_REQUIRED,
        title: 'Unknown Title',
        provider: 'HubCloud',
        destination: null,
        error: 'Human verification required on source page.',
        sourceUrl: normalizedUrl,
        mediatorUrl: null,
        elapsedMs: finishedAt - resolverStartedAt,
        metrics: createMetrics(finishedAt),
      };
    }

    if (sourceFetch.success && sourceFetch.body) {
      sourceHtml = sourceFetch.body;
      finalUrl = sourceFetch.finalUrl || normalizedUrl;
    } else {
      // Fallback fetch
      const directRes = await fetch(normalizedUrl);
      sourceHtml = await directRes.text();
      finalUrl = directRes.url || normalizedUrl;
    }
  } catch (err) {
    try {
      const directRes = await fetch(normalizedUrl);
      sourceHtml = await directRes.text();
      finalUrl = directRes.url || normalizedUrl;
    } catch {
      const finishedAt = Date.now();
      return {
        success: false,
        state: Hub4UState.ERROR,
        title: 'Unknown Title',
        provider: 'HubCloud',
        destination: null,
        error: `Failed to fetch source page: ${err.message}`,
        sourceUrl: normalizedUrl,
        mediatorUrl: null,
        elapsedMs: finishedAt - resolverStartedAt,
        metrics: createMetrics(finishedAt),
      };
    }
  }

  // Check HTML for challenge signatures
  const challengeCheck = detectHumanVerificationChallenge(sourceHtml, finalUrl);
  if (challengeCheck.isChallenge) {
    const finishedAt = Date.now();
    return {
      success: false,
      state: Hub4UState.VERIFICATION_REQUIRED,
      title: 'Unknown Title',
      provider: 'HubCloud',
      destination: null,
      error: 'Human verification required.',
      sourceUrl: normalizedUrl,
      mediatorUrl: null,
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: createMetrics(finishedAt),
    };
  }

  // 2. Extract download buttons & dynamic mediator URLs
  const extracted = extract4KHDHubLinks(sourceHtml, finalUrl);
  const links = extracted.links || [];

  if (links.length === 0) {
    const finishedAt = Date.now();
    return {
      success: false,
      state: Hub4UState.DESTINATION_NOT_FOUND,
      title: extracted.title || 'Unknown Title',
      provider: 'HubCloud',
      destination: null,
      error: 'No download links found on page.',
      sourceUrl: normalizedUrl,
      mediatorUrl: null,
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: createMetrics(finishedAt),
    };
  }

  // 3. Filter candidates based on target quality / scope
  let candidates = [...links];
  if (options.targetQuality && options.targetQuality !== 'all') {
    const filtered = candidates.filter((l) => matchesQuality(l.quality, options.targetQuality));
    if (filtered.length > 0) candidates = filtered;
  }
  if (options.targetScope && options.targetScope !== 'all') {
    const filtered = candidates.filter((l) => l.scope === options.targetScope);
    if (filtered.length > 0) candidates = filtered;
  }

  // Select primary candidate (first candidate matching preferences)
  const targetItem = candidates[0];
  logger.parsing(`Resolving mediator for candidate "${targetItem.title}" [${targetItem.quality}]`);

  // 4. Resolve candidate through mediator
  const mediatorStart = Date.now();
  const useHttpFirst = options.useHttpFirst !== false;
  const resolution = useHttpFirst
    ? await resolveMediatorHttpFirst(targetItem.mediatorUrl, {
        meta: targetItem,
        countdownTimeout: options.countdownTimeout || 35000,
        navigationTimeout: options.navigationTimeout || 20000,
        headless: options.headless !== undefined ? options.headless : true,
        existingBrowser: options.existingBrowser,
      })
    : await resolveMediatorFlow(targetItem.mediatorUrl, {
        meta: targetItem,
        countdownTimeout: options.countdownTimeout || 35000,
        navigationTimeout: options.navigationTimeout || 20000,
        headless: options.headless !== undefined ? options.headless : true,
        existingBrowser: options.existingBrowser,
      });

  const finishedAt = Date.now();
  const mediatorDurationMs = finishedAt - mediatorStart;

  // 5. Handle verification required
  if (resolution.state === 'CAPTCHA_REQUIRED') {
    return {
      success: false,
      state: Hub4UState.VERIFICATION_REQUIRED,
      title: extracted.title,
      provider: 'HubCloud',
      destination: null,
      error: resolution.error || 'Human verification required during mediator step.',
      sourceUrl: normalizedUrl,
      mediatorUrl: targetItem.mediatorUrl,
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: createMetrics(finishedAt),
    };
  }

  // 6. Handle timeout
  if (resolution.state === 'TIMEOUT') {
    return {
      success: false,
      state: Hub4UState.TIMEOUT,
      title: extracted.title,
      provider: 'HubCloud',
      destination: null,
      error: resolution.error || 'Timed out waiting for mediator resolution.',
      sourceUrl: normalizedUrl,
      mediatorUrl: targetItem.mediatorUrl,
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: createMetrics(finishedAt),
    };
  }

  // 7. Handle success
  if (resolution.success && resolution.destination && isHubCloudDriveUrl(resolution.destination)) {
    let finalTitle = resolution.meta?.filename || targetItem.filename || extracted.title;
    try {
      if (!finalTitle || finalTitle === 'Unknown Title') {
        const hubMeta = await fetchHubCloudMetadata(resolution.destination);
        if (hubMeta?.filename) finalTitle = hubMeta.filename;
      }
    } catch {}

    const stages = resolution.stageDurations || {};
    const timings = resolution.timings || {};

    return {
      success: true,
      state: Hub4UState.DESTINATION_FOUND,
      title: finalTitle,
      provider: 'HubCloud',
      destination: resolution.destination,
      error: null,
      sourceUrl: normalizedUrl,
      mediatorUrl: targetItem.mediatorUrl,
      elapsedMs: finishedAt - resolverStartedAt,
      metrics: createMetrics(finishedAt),
      details: {
        quality: targetItem.quality,
        filename: finalTitle,
        scope: targetItem.scope,
        totalExtractedLinks: links.length,
        httpMs: timings.httpMs || stages.MEDIATOR_OPEN || 0,
        browserMs: timings.browserMs || (mediatorDurationMs - (timings.httpMs || 0)),
        externalWaitMs: (stages.WAITING || 0) + (stages.COUNTDOWN || 0),
        cacheHit: timings.cacheHit || false,
      },
    };
  }

  // 8. Destination not found
  return {
    success: false,
    state: Hub4UState.DESTINATION_NOT_FOUND,
    title: extracted.title,
    provider: 'HubCloud',
    destination: null,
    error: resolution.error || 'The resolver could not find a publicly available HubCloud destination.',
    sourceUrl: normalizedUrl,
    mediatorUrl: targetItem.mediatorUrl,
    elapsedMs: finishedAt - resolverStartedAt,
    metrics: createMetrics(finishedAt),
  };
}

export default {
  resolve4KHub4U,
};
