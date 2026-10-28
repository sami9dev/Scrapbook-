/**
 * HTTP-first mediator resolver for 4KHDHub → Mediator → HubCloud pipeline.
 *
 * Architecture (per spec):
 *   HTTP-FIRST RESOLVER
 *     1. Follow ordinary redirects, record redirect chain
 *     2. Inspect returned HTML for:
 *        a. Publicly exposed HubCloud /drive/ destination -> return immediately
 *        b. Cloudflare / Turnstile challenge -> return verification_required
 *        c. Mediator page (countdown / waiting state) -> proceed
 *     3. If HTTP inspection cannot determine state -> Browser fallback
 *
 * Rules:
 *   - Never launch Chromium unless HTTP inspection needs it
 *   - Reuse browser contexts rather than creating new browsers per link
 *   - HTTP concurrency is controlled independently from browser concurrency
 *   - Deduplicate mediator URLs before processing
 *   - Cancel unnecessary work once destination is found
 *   - Short-TTL cache for public HubCloud destination results
 *   - Never cache/expose cookies, auth credentials, or challenge tokens
 *   - Never bypass Cloudflare / Turnstile
 *   - Detailed timing metrics for every stage
 */

import * as cheerio from 'cheerio';
import { isHubCloudDriveUrl } from '../../providers/hubcloud/validator.js';
import { logger } from '../../logging/logger.js';
import { STATES, MediatorStateMachine } from './stateMachine.js';
import {
  detectChallengeInPage,
  detectGetLinkControl,
  detectVerifyControl,
  detectCountdownInPage,
  detectInvalidLinkInPage,
  INVALID_LINK_PATTERNS,
} from './detector.js';

// ─── Public Result Cache (short TTL, only legitimate HubCloud URLs) ──────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_SIZE = 200;

const _resultCache = new Map(); // mediatorUrl -> { destination, cachedAt }

function cacheGet(mediatorUrl) {
  const entry = _resultCache.get(mediatorUrl);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    _resultCache.delete(mediatorUrl);
    return null;
  }
  return entry.destination;
}

function cacheSet(mediatorUrl, destination) {
  // Only cache legitimate public HubCloud drive URLs
  if (!isHubCloudDriveUrl(destination)) return;
  // Prevent unbounded growth
  if (_resultCache.size >= CACHE_MAX_SIZE) {
    const oldestKey = _resultCache.keys().next().value;
    _resultCache.delete(oldestKey);
  }
  _resultCache.set(mediatorUrl, { destination, cachedAt: Date.now() });
}

export function clearHttpResolverCache() {
  _resultCache.clear();
}

export function getHttpResolverCacheStats() {
  const now = Date.now();
  let valid = 0;
  for (const entry of _resultCache.values()) {
    if (now - entry.cachedAt <= CACHE_TTL_MS) valid++;
  }
  return { size: _resultCache.size, valid, ttlMs: CACHE_TTL_MS };
}

// ─── HTTP Inspection Helpers ──────────────────────────────────────────────────

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const CHALLENGE_TEXT_INDICATORS = [
  'just a moment',
  'attention required',
  'checking your browser',
  'verify you are human',
  'cloudflare turnstile',
  'please verify you are a human',
  'enable javascript and cookies to continue',
];

const CHALLENGE_SELECTORS_HTML = [
  '.cf-turnstile',
  'div[id*="cf-turnstile"]',
  'iframe[src*="challenges.cloudflare.com"]',
  '#cf-challenge-running',
  '#challenge-stage',
  '#challenge-form',
  '.g-recaptcha',
  '.h-captcha',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha.com"]',
];

const GET_LINK_ANCHOR_PATTERNS = [
  /get\s*links?/i,
  /get\s*download\s*links?/i,
  /generate\s*links?/i,
  /go\s*to\s*download/i,
  /continue\s*to\s*links?/i,
  /download\s*links?/i,
  /fast\s*cloud\s*download/i,
];

/**
/**
 * Extracts and decodes obfuscated mediator payloads embedded in HTML (e.g. greenmotors / fast-share pattern).
 * Encoded format: s('o', '<base64 payload>', ...)
 * Payload decoding: base64 -> base64 -> rot13 -> base64 -> JSON -> json.o -> base64 -> HubCloud drive URL
 *
 * @param {string} html
 * @returns {string|null} The verified HubCloud drive URL, or null if not present
 */
export function extractEmbeddedMediatorPayload(html) {
  if (!html || typeof html !== 'string') return null;

  // Pattern: s('o', '...', ...)
  const match = html.match(/s\(\s*['"]o['"]\s*,\s*['"]([A-Za-z0-9+/=]+)['"]/);
  if (!match) return null;

  try {
    const rawB64 = match[1];
    const p1 = Buffer.from(rawB64, 'base64').toString('utf-8');
    const p2 = Buffer.from(p1, 'base64').toString('utf-8');
    const p3 = p2.replace(/[a-zA-Z]/g, (c) => {
      const code = c.charCodeAt(0);
      return String.fromCharCode(
        code + (c <= 'Z' ? (code <= 77 ? 13 : -13) : (code <= 109 ? 13 : -13))
      );
    });
    const p4 = Buffer.from(p3, 'base64').toString('utf-8');
    const json = JSON.parse(p4);
    if (json && json.o) {
      const dest = Buffer.from(json.o, 'base64').toString('utf-8').trim();
      if (
        isHubCloudDriveUrl(dest) ||
        /hubdrive\.[a-z]+/i.test(dest) ||
        /^https?:\/\/[a-z0-9.-]+\/(?:drive|file)\/[a-z0-9_-]+/i.test(dest)
      ) {
        return dest;
      }
    }
  } catch {
    // Decoding failed or malformed payload
  }

  return null;
}

/**
 * Inspects raw HTML via Cheerio (no browser needed).
 * Returns the detected state and any extracted destination URL.
 *
 * @param {string} html
 * @param {string} url - The URL this HTML was fetched from
 * @returns {{
 *   state: 'destination_found'|'challenge'|'get_link_available'|'mediator'|'unknown',
 *   destination?: string,
 *   getLinkHref?: string,
 *   timings: { inspectMs: number }
 * }}
 */
export function inspectHtml(html, url = '') {
  const t0 = Date.now();

  if (!html || typeof html !== 'string') {
    return { state: 'unknown', timings: { inspectMs: Date.now() - t0 } };
  }

  const $ = cheerio.load(html);
  const title = $('title').text().toLowerCase().trim();
  const bodyText = $('body').text().toLowerCase();

  // 1. Challenge / Cloudflare detection (highest priority — never bypass)
  for (const sel of CHALLENGE_SELECTORS_HTML) {
    if ($(sel).length > 0) {
      return { state: 'challenge', reason: `Found challenge selector: ${sel}`, timings: { inspectMs: Date.now() - t0 } };
    }
  }
  for (const ind of CHALLENGE_TEXT_INDICATORS) {
    if (title.includes(ind) || bodyText.includes(ind)) {
      return { state: 'challenge', reason: `Found challenge phrase: "${ind}"`, timings: { inspectMs: Date.now() - t0 } };
    }
  }

  // 1.2. Check for invalid / expired mediator link (fast-fail, never wait 35s)
  for (const regex of INVALID_LINK_PATTERNS) {
    if (regex.test(title)) {
      return { state: 'invalid_link', reason: `Page title indicates dead link: "${title}"`, timings: { inspectMs: Date.now() - t0 } };
    }
    if (bodyText.length < 500 && regex.test(bodyText)) {
      return { state: 'invalid_link', reason: `Page text indicates dead link: "${bodyText.slice(0, 100).trim()}"`, timings: { inspectMs: Date.now() - t0 } };
    }
  }
  let deadElementFound = null;
  $('h1, h2, h3, h4, .error, .alert, p, b, strong').each((_, el) => {
    const t = $(el).text().trim();
    if (t.length > 0 && t.length < 150) {
      for (const regex of INVALID_LINK_PATTERNS) {
        if (regex.test(t)) {
          deadElementFound = t;
          return false;
        }
      }
    }
  });
  if (deadElementFound) {
    return { state: 'invalid_link', reason: `Page element indicates dead link: "${deadElementFound}"`, timings: { inspectMs: Date.now() - t0 } };
  }

  // 1.5. Check for embedded obfuscated mediator destination payload
  const embeddedDest = extractEmbeddedMediatorPayload(html);
  if (embeddedDest) {
    return { state: 'destination_found', destination: embeddedDest, timings: { inspectMs: Date.now() - t0 } };
  }

  // 2. Direct HubCloud destination in anchors or redirected URL
  const anchors = $('a[href]').toArray();
  for (const el of anchors) {
    const href = $(el).attr('href') || '';
    if (isHubCloudDriveUrl(href)) {
      return { state: 'destination_found', destination: href, timings: { inspectMs: Date.now() - t0 } };
    }
  }

  // Also check if the final URL itself is a HubCloud destination
  if (isHubCloudDriveUrl(url)) {
    return { state: 'destination_found', destination: url, timings: { inspectMs: Date.now() - t0 } };
  }

  // 3. "Get Link" anchor with HubCloud href available inline
  for (const el of anchors) {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const text = ($el.text() || '').trim();
    const matches = GET_LINK_ANCHOR_PATTERNS.some((p) => p.test(text));
    if (matches && href && href !== '#' && !href.startsWith('javascript:')) {
      if (isHubCloudDriveUrl(href)) {
        return { state: 'destination_found', destination: href, timings: { inspectMs: Date.now() - t0 } };
      }
      return { state: 'get_link_available', getLinkHref: href, timings: { inspectMs: Date.now() - t0 } };
    }
  }

  // 4. Mediator / countdown page detection
  const hasMediatorSignals =
    url.includes('greenmotors') ||
    url.includes('fast-share') ||
    url.includes('fastdl') ||
    url.includes('mediator') ||
    url.includes('?id=') ||
    bodyText.includes('please wait') ||
    bodyText.includes('generating link') ||
    bodyText.includes('countdown') ||
    /verify\s*to\s*continue/i.test(bodyText);

  if (hasMediatorSignals) {
    return { state: 'mediator', timings: { inspectMs: Date.now() - t0 } };
  }

  return { state: 'unknown', timings: { inspectMs: Date.now() - t0 } };
}

/**
 * HTTP-first mediator resolution attempt.
 * Follows redirects and inspects HTML. Returns null if browser is needed.
 *
 * @param {string} mediatorUrl
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {object} [options.meta]
 * @returns {Promise<{
 *   resolved: boolean,
 *   destination?: string,
 *   state: string,
 *   reason?: string,
 *   redirectChain: string[],
 *   timings: object
 * }>}
 */
export async function httpFirstResolve(mediatorUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 12000;
  const timings = { httpMs: 0, inspectMs: 0 };
  const redirectChain = [];
  const httpStart = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(mediatorUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    timings.httpMs = Date.now() - httpStart;
    const finalUrl = response.url || mediatorUrl;
    redirectChain.push(finalUrl);

    // Check if redirected directly to HubCloud
    if (isHubCloudDriveUrl(finalUrl)) {
      return {
        resolved: true,
        destination: finalUrl,
        state: 'destination_found',
        redirectChain,
        timings,
      };
    }

    const html = await response.text();
    const inspectStart = Date.now();
    const inspection = inspectHtml(html, finalUrl);
    timings.inspectMs = Date.now() - inspectStart;

    if (inspection.state === 'destination_found') {
      return {
        resolved: true,
        destination: inspection.destination,
        state: 'destination_found',
        redirectChain,
        timings,
      };
    }

    if (inspection.state === 'challenge') {
      return {
        resolved: true,
        destination: null,
        state: 'challenge',
        reason: inspection.reason,
        redirectChain,
        timings,
      };
    }

    if (inspection.state === 'invalid_link') {
      return {
        resolved: true,
        destination: null,
        state: 'invalid_link',
        reason: inspection.reason,
        redirectChain,
        timings,
      };
    }

    // get_link_available or mediator/unknown -> need browser
    return {
      resolved: false,
      state: inspection.state,
      finalUrl,
      html,
      redirectChain,
      timings,
    };
  } catch (err) {
    timings.httpMs = Date.now() - httpStart;
    logger.warning(`[HTTP-FIRST] HTTP fetch failed for ${mediatorUrl}: ${err.message}`);
    return {
      resolved: false,
      state: 'http_error',
      error: err.message,
      redirectChain,
      timings,
    };
  }
}

// ─── Browser Fallback Resolver ────────────────────────────────────────────────

/**
 * Browser-based resolution for cases where HTTP inspection could not determine state.
 * Reuses a shared Browser instance when provided.
 *
 * @param {string} mediatorUrl
 * @param {object} [options]
 * @param {import('playwright').Browser} [options.existingBrowser]
 * @param {object} [options.meta]
 * @param {number} [options.openTimeout]
 * @param {number} [options.countdownTimeout]
 * @param {number} [options.navigationTimeout]
 * @param {boolean} [options.headless]
 * @param {MediatorStateMachine} [options.sm] - Already-initialized state machine
 * @returns {Promise<object>} MediatorStateMachine summary
 */
async function browserFallbackResolve(mediatorUrl, options = {}) {
  const sm = options.sm;
  const openTimeout = options.openTimeout || 25000;
  const countdownTimeout = options.countdownTimeout || 35000;
  const navigationTimeout = options.navigationTimeout || 20000;
  const headless = options.headless !== undefined ? options.headless : true;

  let browser = options.existingBrowser || null;
  let ownBrowser = false;

  try {
    if (!browser) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      ownBrowser = true;
    }

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
    });

    // Keep timer running in headless mode
    await context.addInitScript(() => {
      try {
        Object.defineProperty(document, 'hidden', { value: false, writable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
        document.hasFocus = () => true;
      } catch {}
    });

    // Abort non-essential assets and ad networks
    await context.route('**/*', (route) => {
      const req = route.request();
      if (['image', 'font', 'media'].includes(req.resourceType())) return route.abort();
      const url = req.url();
      if (/admaven|propellerads|popads|alwingulla|adsterra|monetag|google-analytics/i.test(url)) return route.abort();
      return route.continue();
    });

    const page = await context.newPage();
    page.setDefaultTimeout(openTimeout);

    const openedPages = [page];
    context.on('page', (newPage) => {
      openedPages.push(newPage);
    });

    sm.transition(STATES.MEDIATOR_OPEN, { info: `Browser navigating to ${mediatorUrl}` });

    try {
      await page.goto(mediatorUrl, { waitUntil: 'domcontentloaded', timeout: openTimeout });
    } catch (navErr) {
      sm.transition(STATES.NETWORK_ERROR, { error: `Browser navigation failed: ${navErr.message}` });
      return sm.getSummary();
    }

    // Immediate dead/invalid link check
    const initialInvalid = await detectInvalidLinkInPage(page);
    if (initialInvalid.isInvalid) {
      sm.transition(STATES.INVALID_LINK, {
        error: `Upstream mediator link is invalid or expired: ${initialInvalid.reason}`,
        info: 'Fast-fail: upstream link dead on 4KHDHub/mediator host.',
      });
      return sm.getSummary();
    }

    // Immediate challenge check
    const initialChallenge = await detectChallengeInPage(page);
    if (initialChallenge.isChallenge) {
      sm.transition(STATES.CAPTCHA_REQUIRED, {
        error: `Human verification required: ${initialChallenge.reason}`,
        info: 'Pausing resolver. No attempt made to defeat challenge.',
      });
      return sm.getSummary();
    }

    sm.transition(STATES.WAITING, { info: 'Page loaded, observing state transitions' });

    const countdownStart = Date.now();
    let getLinkControl = null;
    let timerObserved = false;
    let verifyAttempted = false;

    while (Date.now() - countdownStart < countdownTimeout) {
      const invalidCheck = await detectInvalidLinkInPage(page);
      if (invalidCheck.isInvalid) {
        sm.transition(STATES.INVALID_LINK, {
          error: `Upstream mediator link is invalid or expired: ${invalidCheck.reason}`,
          info: 'Fast-fail: upstream link dead on 4KHDHub/mediator host.',
        });
        return sm.getSummary();
      }

      const challenge = await detectChallengeInPage(page);
      if (challenge.isChallenge) {
        sm.transition(STATES.CAPTCHA_REQUIRED, { error: `Challenge appeared during wait: ${challenge.reason}` });
        return sm.getSummary();
      }

      for (const p of openedPages) {
        const currentUrl = p.url();
        if (isHubCloudDriveUrl(currentUrl)) {
          sm.transition(STATES.HUBCLOUD_DETECTED, { destination: currentUrl, info: 'HubCloud detected during wait' });
          return sm.getSummary();
        }
      }

      getLinkControl = await detectGetLinkControl(page);
      if (getLinkControl?.available) break;

      if (!verifyAttempted) {
        const verifyControl = await detectVerifyControl(page);
        if (verifyControl?.available) {
          try {
            if (verifyControl.selector) {
              await page.click(verifyControl.selector, { timeout: 3000 }).catch(async () => {
                await page.evaluate((sel) => {
                  const el = document.querySelector(sel) || document.getElementById('verify_btn');
                  if (el) el.click();
                }, verifyControl.selector);
              });
            }
            verifyAttempted = true;
          } catch (vErr) {
            logger.warning(`[BROWSER] Verify click error: ${vErr.message}`);
          }
        }
      }

      const timerState = await detectCountdownInPage(page);
      if (timerState.hasTimer && !timerObserved) {
        timerObserved = true;
        sm.transition(STATES.COUNTDOWN, {
          secondsRemaining: timerState.secondsRemaining,
          info: `Timer active: ${timerState.secondsRemaining ?? 'unknown'} seconds remaining`,
        });
      }

      await page.waitForTimeout(500);
    }

    if (!getLinkControl?.available) {
      sm.transition(STATES.TIMEOUT, {
        error: timerObserved
          ? `Timed out waiting for Get Link after countdown (${countdownTimeout}ms)`
          : `Get Link control not found within ${countdownTimeout}ms`,
      });
      return sm.getSummary();
    }

    sm.transition(STATES.LINK_READY, {
      type: getLinkControl.type,
      text: getLinkControl.text,
      href: getLinkControl.href,
      info: `Get Link ready (${getLinkControl.type}: "${getLinkControl.text}")`,
    });

    // Capture HubCloud destination from anchor href directly if available
    if (getLinkControl.href && isHubCloudDriveUrl(getLinkControl.href)) {
      sm.transition(STATES.HUBCLOUD_DETECTED, {
        destination: getLinkControl.href,
        info: 'Captured directly from Get Link href',
      });
      return sm.getSummary();
    }

    sm.transition(STATES.GET_LINK_ACTION, {
      info: `Executing user action on ${getLinkControl.selector || 'Get Link'}`,
    });

    try {
      if (getLinkControl.selector) {
        await page.click(getLinkControl.selector, { timeout: 3000 }).catch(async () => {
          await page.evaluate((sel) => {
            const el = document.querySelector(sel) || document.querySelector('[data-getlink-target="true"]');
            if (el) el.click();
          }, getLinkControl.selector);
        });
      }
    } catch (clickErr) {
      logger.warning(`[BROWSER] Click error: ${clickErr.message}`);
    }

    sm.transition(STATES.NAVIGATING, { info: 'Observing navigation, tabs, and redirects' });

    const navStart = Date.now();
    let detectedUrl = null;

    while (Date.now() - navStart < navigationTimeout) {
      for (const p of openedPages) {
        const u = p.url();
        if (isHubCloudDriveUrl(u)) { detectedUrl = u; break; }
      }
      if (detectedUrl) break;

      for (const p of openedPages) {
        try {
          const directHubLink = await p.evaluate(() => {
            const a = Array.from(document.querySelectorAll('a[href*="hubcloud."]'))
              .find((el) => el.href && el.href.includes('/drive/'));
            return a ? a.href : null;
          });
          if (directHubLink && isHubCloudDriveUrl(directHubLink)) { detectedUrl = directHubLink; break; }
        } catch {}
      }
      if (detectedUrl) break;

      await page.waitForTimeout(500);
    }

    if (detectedUrl && isHubCloudDriveUrl(detectedUrl)) {
      sm.transition(STATES.HUBCLOUD_DETECTED, { destination: detectedUrl, info: `Resolved: ${detectedUrl}` });
    } else {
      sm.transition(STATES.HUBCLOUD_DESTINATION_NOT_FOUND, {
        error: 'No valid HubCloud drive destination detected after Get Link navigation',
      });
    }

    return sm.getSummary();
  } catch (err) {
    sm.transition(STATES.NETWORK_ERROR, { error: err.message });
    return sm.getSummary();
  } finally {
    if (ownBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ─── Main: HTTP-First with Browser Fallback ───────────────────────────────────

/**
 * Resolves a 4KHDHub mediator URL to a final HubCloud drive destination.
 *
 * Strategy:
 *   1. Check cache (public results only, short TTL)
 *   2. HTTP-first: follow redirects, inspect HTML
 *      a. Destination found? Return immediately
 *      b. Challenge? Return CAPTCHA_REQUIRED (no bypass)
 *      c. Mediator/unknown? Fall through to browser
 *   3. Browser fallback: reuse existing browser context if provided
 *
 * @param {string} mediatorUrl
 * @param {object} [options]
 * @param {object} [options.meta]
 * @param {number} [options.openTimeout]
 * @param {number} [options.countdownTimeout]
 * @param {number} [options.navigationTimeout]
 * @param {boolean} [options.headless]
 * @param {import('playwright').Browser} [options.existingBrowser]
 * @param {boolean} [options.skipCache] - Skip cache lookup (for testing/benchmark)
 * @returns {Promise<object>} MediatorStateMachine summary with added timing fields
 */
export async function resolveMediatorHttpFirst(mediatorUrl, options = {}) {
  const totalStart = Date.now();
  const timings = {
    totalMs: 0,
    httpMs: 0,
    inspectMs: 0,
    browserMs: 0,
    cacheHit: false,
    usedBrowser: false,
    browserLaunched: false,
  };

  const meta = {
    sourceUrl: options.meta?.sourceUrl || '',
    mediatorUrl,
    title: options.meta?.title || 'Unknown Title',
    quality: options.meta?.quality || 'unknown',
    provider: options.meta?.provider || 'HubCloud',
  };

  const sm = new MediatorStateMachine(meta);

  // Validate
  if (!mediatorUrl || typeof mediatorUrl !== 'string' || !mediatorUrl.startsWith('http')) {
    sm.transition(STATES.INVALID_MEDIATOR, { error: `Invalid mediator URL: ${mediatorUrl}` });
    timings.totalMs = Date.now() - totalStart;
    return { ...sm.getSummary(), timings };
  }

  // Already a destination
  if (isHubCloudDriveUrl(mediatorUrl)) {
    sm.transition(STATES.HUBCLOUD_DETECTED, { destination: mediatorUrl, info: 'Already a HubCloud destination URL' });
    timings.totalMs = Date.now() - totalStart;
    return { ...sm.getSummary(), timings };
  }

  // Cache lookup (only for public HubCloud results)
  if (!options.skipCache) {
    const cached = cacheGet(mediatorUrl);
    if (cached) {
      timings.cacheHit = true;
      timings.totalMs = Date.now() - totalStart;
      sm.transition(STATES.HUBCLOUD_DETECTED, { destination: cached, info: 'Cache hit (short-TTL public result)' });
      logger.log('HTTP-FIRST', `Cache hit for ${mediatorUrl} -> ${cached}`);
      return { ...sm.getSummary(), timings };
    }
  }

  // ── Phase 1: HTTP-first ──────────────────────────────────────────────────
  logger.log('HTTP-FIRST', `[HTTP] Inspecting ${mediatorUrl}`);
  const httpResult = await httpFirstResolve(mediatorUrl, {
    timeoutMs: options.httpTimeoutMs ?? 12000,
    meta,
  });

  timings.httpMs = httpResult.timings?.httpMs ?? 0;
  timings.inspectMs = httpResult.timings?.inspectMs ?? 0;

  if (httpResult.resolved) {
    if (httpResult.state === 'destination_found') {
      logger.log('HTTP-FIRST', `[HTTP] Destination found without browser: ${httpResult.destination}`);
      sm.transition(STATES.MEDIATOR_OPEN, { info: 'HTTP inspection succeeded' });
      sm.transition(STATES.HUBCLOUD_DETECTED, {
        destination: httpResult.destination,
        info: 'Resolved via HTTP inspection (no browser used)',
      });
      cacheSet(mediatorUrl, httpResult.destination);
      timings.usedBrowser = false;
      timings.totalMs = Date.now() - totalStart;
      return { ...sm.getSummary(), timings };
    }

    if (httpResult.state === 'challenge') {
      logger.log('HTTP-FIRST', `[HTTP] Challenge detected: ${httpResult.reason}`);
      sm.transition(STATES.MEDIATOR_OPEN, { info: 'HTTP inspection: challenge page' });
      sm.transition(STATES.CAPTCHA_REQUIRED, {
        error: `Human verification required (HTTP): ${httpResult.reason}`,
        info: 'Pausing resolver. No attempt made to defeat challenge.',
      });
      timings.usedBrowser = false;
      timings.totalMs = Date.now() - totalStart;
      return { ...sm.getSummary(), timings };
    }

    if (httpResult.state === 'invalid_link') {
      logger.log('HTTP-FIRST', `[HTTP] Invalid/expired link detected: ${httpResult.reason}`);
      sm.transition(STATES.MEDIATOR_OPEN, { info: 'HTTP inspection: invalid link' });
      sm.transition(STATES.INVALID_LINK, {
        error: `Upstream mediator link is invalid or expired: ${httpResult.reason}`,
        info: 'Fast-fail: upstream link dead on source site / mediator host.',
      });
      timings.usedBrowser = false;
      timings.totalMs = Date.now() - totalStart;
      return { ...sm.getSummary(), timings };
    }
  }

  // ── Phase 2: Browser fallback ────────────────────────────────────────────
  const browserStart = Date.now();
  timings.usedBrowser = true;
  timings.browserLaunched = !options.existingBrowser;

  logger.log('HTTP-FIRST', `[BROWSER] HTTP inconclusive (state=${httpResult.state}), launching browser for ${mediatorUrl}`);

  const browserResult = await browserFallbackResolve(mediatorUrl, {
    ...options,
    sm,
  });

  timings.browserMs = Date.now() - browserStart;
  timings.totalMs = Date.now() - totalStart;

  // Cache successful results
  if (browserResult.success && isHubCloudDriveUrl(browserResult.destination)) {
    cacheSet(mediatorUrl, browserResult.destination);
  }

  return { ...browserResult, timings };
}

// ─── Batch Processor ─────────────────────────────────────────────────────────

/**
 * Processes a batch of mediator URLs with HTTP-first strategy.
 * Deduplicates candidates before processing.
 * Splits work into HTTP phase (high concurrency) and Browser phase (lower concurrency).
 *
 * @param {Array<{ mediatorUrl: string, meta?: object }>} candidates
 * @param {object} [options]
 * @param {number} [options.httpConcurrency] - HTTP workers (default: 10)
 * @param {number} [options.browserConcurrency] - Browser workers (default: 3)
 * @param {boolean} [options.headless]
 * @param {number} [options.httpTimeoutMs]
 * @param {number} [options.countdownTimeout]
 * @param {number} [options.navigationTimeout]
 * @param {boolean} [options.skipCache]
 * @returns {Promise<{
 *   results: Array<{ mediatorUrl: string, resolution: object, meta: object }>,
 *   batchTimings: {
 *     totalMs: number,
 *     httpPhaseMs: number,
 *     browserPhaseMs: number,
 *     httpResolvedCount: number,
 *     browserResolvedCount: number,
 *     cacheHits: number,
 *     browserLaunches: number,
 *     deduplicatedCount: number
 *   }
 * }>}
 */
export async function resolveMediatorBatchHttpFirst(candidates, options = {}) {
  const batchStart = Date.now();
  const httpConcurrency = options.httpConcurrency ?? 10;
  const browserConcurrency = options.browserConcurrency ?? 3;
  const batchTimings = {
    totalMs: 0,
    httpPhaseMs: 0,
    browserPhaseMs: 0,
    httpResolvedCount: 0,
    browserResolvedCount: 0,
    cacheHits: 0,
    browserLaunches: 0,
    deduplicatedCount: 0,
  };

  // ── Step 1: Deduplicate mediator URLs ────────────────────────────────────
  const seen = new Set();
  const deduped = [];
  for (const candidate of candidates) {
    if (!candidate.mediatorUrl || seen.has(candidate.mediatorUrl)) continue;
    seen.add(candidate.mediatorUrl);
    deduped.push(candidate);
  }
  batchTimings.deduplicatedCount = candidates.length - deduped.length;
  logger.log('HTTP-FIRST', `[BATCH] ${candidates.length} candidates -> ${deduped.length} after deduplication`);

  if (deduped.length === 0) {
    batchTimings.totalMs = Date.now() - batchStart;
    return { results: [], batchTimings };
  }

  const results = new Array(deduped.length);

  // ── Step 2: HTTP Phase (high concurrency) ────────────────────────────────
  const httpPhaseStart = Date.now();

  /** Items that need browser after HTTP phase */
  const browserQueue = [];

  await runBounded(
    deduped.map((candidate, idx) => async () => {
      const cacheHit = !options.skipCache && !!cacheGet(candidate.mediatorUrl);
      if (cacheHit) batchTimings.cacheHits++;

      const resolution = await resolveMediatorHttpFirst(candidate.mediatorUrl, {
        meta: candidate.meta,
        httpTimeoutMs: options.httpTimeoutMs ?? 12000,
        skipCache: options.skipCache,
        // Never pass existingBrowser in HTTP phase — no browser launched here
      });

      results[idx] = { mediatorUrl: candidate.mediatorUrl, meta: candidate.meta, resolution };

      if (resolution.timings?.cacheHit) {
        // Already accounted
      } else if (!resolution.timings?.usedBrowser) {
        batchTimings.httpResolvedCount++;
      } else {
        // Shouldn't happen in HTTP-only phase, but handle gracefully
        browserQueue.push({ idx, candidate });
      }
    }),
    httpConcurrency
  );

  batchTimings.httpPhaseMs = Date.now() - httpPhaseStart;

  // Count items that need browser: those not yet resolved after HTTP-first
  const needBrowser = deduped.reduce((acc, candidate, idx) => {
    const res = results[idx]?.resolution;
    if (
      res &&
      !res.success &&
      res.state !== STATES.CAPTCHA_REQUIRED &&
      res.state !== STATES.INVALID_MEDIATOR &&
      !res.timings?.cacheHit
    ) {
      acc.push({ idx, candidate });
    }
    return acc;
  }, []);

  // ── Step 3: Browser Phase (lower concurrency, shared browser) ────────────
  const browserPhaseStart = Date.now();

  if (needBrowser.length > 0) {
    logger.log('HTTP-FIRST', `[BATCH] ${needBrowser.length} item(s) need browser fallback (concurrency=${browserConcurrency})`);

    const { chromium } = await import('playwright');
    let sharedBrowser = null;
    let ownBrowser = false;

    try {
      sharedBrowser = await chromium.launch({
        headless: options.headless !== undefined ? options.headless : true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      ownBrowser = true;
      batchTimings.browserLaunches = 1; // One browser for entire batch

      await runBounded(
        needBrowser.map(({ idx, candidate }) => async () => {
          const resolution = await resolveMediatorHttpFirst(candidate.mediatorUrl, {
            meta: candidate.meta,
            existingBrowser: sharedBrowser,
            headless: options.headless !== undefined ? options.headless : true,
            countdownTimeout: options.countdownTimeout ?? 35000,
            navigationTimeout: options.navigationTimeout ?? 20000,
            skipCache: options.skipCache,
            // Force browser: re-run but it will skip HTTP since we got a non-conclusive result
          });

          results[idx] = { mediatorUrl: candidate.mediatorUrl, meta: candidate.meta, resolution };

          if (resolution.success) batchTimings.browserResolvedCount++;
        }),
        browserConcurrency
      );
    } finally {
      if (ownBrowser && sharedBrowser) {
        await sharedBrowser.close().catch(() => {});
      }
    }
  }

  batchTimings.browserPhaseMs = Date.now() - browserPhaseStart;
  batchTimings.totalMs = Date.now() - batchStart;

  logger.log('HTTP-FIRST', [
    `[BATCH COMPLETE] ${deduped.length} items | Wall: ${batchTimings.totalMs}ms`,
    `| HTTP: ${batchTimings.httpPhaseMs}ms (${batchTimings.httpResolvedCount} resolved)`,
    `| Browser: ${batchTimings.browserPhaseMs}ms (${batchTimings.browserResolvedCount} resolved)`,
    `| CacheHits: ${batchTimings.cacheHits}`,
    `| BrowserLaunches: ${batchTimings.browserLaunches}`,
    `| Deduplicated: ${batchTimings.deduplicatedCount}`,
  ].join(' '));

  return { results: results.filter(Boolean), batchTimings };
}

// ─── Bounded concurrency helper (local, no import cycle) ─────────────────────

async function runBounded(tasks, limit) {
  let active = 0;
  let idx = 0;
  const queue = [];

  const drain = () => {
    while (active < limit && idx < tasks.length) {
      active++;
      const task = tasks[idx++];
      task().finally(() => {
        active--;
        if (queue.length > 0) {
          const next = queue.shift();
          next();
        }
      });
    }
  };

  return new Promise((resolve, reject) => {
    const results = [];
    let completed = 0;

    if (tasks.length === 0) return resolve(results);

    const wrapped = tasks.map((task, i) => async () => {
      try {
        results[i] = await task();
      } catch (err) {
        results[i] = err;
      } finally {
        completed++;
        if (completed === tasks.length) resolve(results);
        drain();
      }
    });

    // Replace tasks with wrapped
    tasks.splice(0, tasks.length, ...wrapped);
    idx = 0;
    drain();
  });
}

export default { resolveMediatorHttpFirst, resolveMediatorBatchHttpFirst, inspectHtml, httpFirstResolve };
