import { chromium } from 'playwright';
import { logger } from '../../logging/logger.js';

/**
 * Redacts sensitive tokens, cookies, authorization headers, and query secrets
 * from URLs, headers, and payloads for secure diagnostic logging.
 *
 * @param {string} str
 * @returns {string}
 */
export function redactSecret(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/([?&])(t|token|sid|secret|key|turnstileToken|session)=([^&#\s]*)/gi, '$1$2=[REDACTED]')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi, '[REDACTED_UUID]');
}

/**
 * Redacts sensitive headers (Cookies, Authorization, Set-Cookie).
 *
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
export function redactHeaders(headers) {
  const redacted = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lowerKey = k.toLowerCase();
    if (lowerKey === 'cookie' || lowerKey === 'set-cookie' || lowerKey === 'authorization') {
      redacted[k] = '[REDACTED]';
    } else {
      redacted[k] = redactSecret(v);
    }
  }
  return redacted;
}

/**
 * Assisted Link Resolver: Uses an authorized browser session where routine button clicks
 * and countdown timers can run, strictly yielding for human verification (e.g. Turnstile, Captcha).
 *
 * Ethical Guardrail: Does NOT automate or bypass verification challenges.
 * Once the human operator completes the verification, it captures the final redirect destination
 * within the exact same browser session (preserving all session cookies, local storage, and state),
 * recording each 3xx response's Location header before navigation continues.
 */
export class AssistedResolver {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs] Maximum time to wait for human interaction / resolution (default 60000ms).
   * @param {number} [options.navigationTimeoutMs] Timeout for initial and page navigations (default 30000ms).
   * @param {boolean} [options.headless] Run headless or visible (default false for assisted mode).
   * @param {Function} [options.onRedirect] Optional callback on each 3xx redirect detected: ({ fromUrl, status, location, error }) => void
   */
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || 60000;
    this.navigationTimeoutMs = options.navigationTimeoutMs || 30000;
    this.headless = options.headless === true;
    this.onRedirect = typeof options.onRedirect === 'function' ? options.onRedirect : null;
  }

  /**
   * Checks whether candidateUrl has reached the intended destination
   * (e.g., navigated past the challenge/mediator origin to an external destination, drive, or final target).
   *
   * @param {string} candidateUrl
   * @param {string} startUrl
   * @returns {boolean}
   */
  _isDestinationUrl(candidateUrl, startUrl) {
    if (!candidateUrl || typeof candidateUrl !== 'string') return false;

    const lowerUrl = candidateUrl.toLowerCase();

    // Ignore non-http/https schemes, blobs, data URIs, error pages
    if (
      !lowerUrl.startsWith('http://') &&
      !lowerUrl.startsWith('https://')
    ) {
      return false;
    }

    // Challenge, CAPTCHA, and Cloudflare URLs are NEVER destinations
    if (
      lowerUrl.includes('cloudflare') ||
      lowerUrl.includes('turnstile') ||
      lowerUrl.includes('challenge-platform') ||
      lowerUrl.includes('/cdn-cgi/') ||
      lowerUrl.includes('hcaptcha') ||
      lowerUrl.includes('recaptcha') ||
      lowerUrl.includes('__cf_chl') ||
      lowerUrl.includes('cf_chl_') ||
      lowerUrl.includes('just a moment')
    ) {
      return false;
    }

    // Ads, trackers, and challenge providers are never destinations
    if (
      lowerUrl.includes('google') ||
      lowerUrl.includes('doubleclick') ||
      lowerUrl.includes('cloudfront.net') ||
      lowerUrl.includes('adservice')
    ) {
      return false;
    }

    try {
      const parsedStart = new URL(startUrl);
      const parsedCandidate = new URL(candidateUrl);

      const candidatePath = parsedCandidate.pathname.toLowerCase();
      const candidateHost = parsedCandidate.hostname.toLowerCase();

      // Shortener, router, and mediator routes are NEVER final destinations
      if (
        candidatePath.startsWith('/r/') ||
        candidatePath.startsWith('/api/') ||
        candidatePath.startsWith('/go/') ||
        candidatePath.startsWith('/download/') ||
        candidatePath.startsWith('/links/') ||
        parsedCandidate.searchParams.has('step') ||
        parsedCandidate.searchParams.has('sid') ||
        candidatePath === '/'
      ) {
        return false;
      }

      // Known intermediate shortener / mediator domains are NEVER destinations
      if (
        candidateHost.includes('latestnewsonline') ||
        candidateHost.includes('xdmovies') ||
        candidateHost.includes('cloudmoviez') ||
        candidateHost.includes('greenmotors') ||
        candidateHost.includes('fast-share')
      ) {
        return false;
      }

      // Explicit storage / drive matches
      if (
        candidateHost.includes('hubcloud') ||
        candidateHost.includes('hubdrive') ||
        candidatePath.includes('/drive/') ||
        candidatePath.includes('/video/') ||
        candidatePath.includes('/file/') ||
        candidateHost.includes('gdlink') ||
        candidateHost.includes('gdflix') ||
        candidateHost.includes('pixeldrain')
      ) {
        return true;
      }

      // If on the same domain (e.g., local mock test /flow-final)
      if (candidateHost === parsedStart.hostname) {
        if (candidatePath !== parsedStart.pathname && !parsedCandidate.searchParams.has('step')) {
          return true;
        }
        return false;
      }

      // If origin has changed to an external non-mediator host
      if (parsedCandidate.origin !== parsedStart.origin) {
        return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  /**
   * Opens the protected link in an authorized, human-assisted browser session
   * and resolves the destination URL.
   *
   * @param {string} url The starting mediator / challenged URL.
   * @returns {Promise<{
   *   originalUrl: string,
   *   finalUrl: string | null,
   *   httpStatus: number,
   *   pageTitle: string,
   *   redirectChain: Array<{ fromUrl: string, status: number, location: string | null, timestamp: number, error: string | null }>,
   *   cookies: Array<object>,
   *   diagnosticLog: Array<object>,
   *   error: string | null
   * }>}
   */
  async resolve(url) {
    let browser = null;
    let context = null;

    const redirectChain = [];
    const diagnosticLog = [];
    let latestHttpStatus = 0;
    let capturedDestinationUrl = null;

    const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

    try {
      browser = await chromium.launch({
        headless: this.headless,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-infobars',
        ],
      });

      // Persistent session context preserving cookies, storage, and session URLs
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });

      // Record network requests with token / credential redaction
      context.on('request', (req) => {
        try {
          diagnosticLog.push({
            type: 'request',
            method: req.method(),
            url: redactSecret(req.url()),
            resourceType: req.resourceType(),
            timestamp: Date.now(),
          });
        } catch {}
      });

      // Hook response listener across the context to capture all 3xx redirects before navigation continues
      context.on('response', (res) => {
        try {
          const status = res.status();
          const resUrl = res.url();
          latestHttpStatus = status;

          diagnosticLog.push({
            type: 'response',
            url: redactSecret(resUrl),
            status,
            timestamp: Date.now(),
          });

          if (REDIRECT_STATUSES.has(status) || (status >= 300 && status < 400)) {
            const headers = res.headers();
            const rawLocation = headers['location'];
            const location =
              typeof rawLocation === 'string' && rawLocation.trim().length > 0
                ? rawLocation.trim()
                : null;

            let redirectError = null;
            if (!location) {
              redirectError = 'Missing Location header in 3xx redirect response';
              logger.warn?.(
                `[AssistedResolver] 3xx redirect (HTTP ${status}) from ${resUrl} is missing Location header`
              );
            } else {
              logger.discovered?.(
                `[AssistedResolver] Recorded 3xx redirect [HTTP ${status}]: ${resUrl} -> ${location}`
              );
            }

            const record = {
              fromUrl: resUrl,
              status,
              location,
              timestamp: Date.now(),
              error: redirectError,
            };
            redirectChain.push(record);

            diagnosticLog.push({
              type: 'redirect',
              fromUrl: redactSecret(resUrl),
              status,
              location: redactSecret(location),
              error: redirectError,
              timestamp: Date.now(),
            });

            if (this.onRedirect) {
              try {
                this.onRedirect(record);
              } catch {}
            }

            // Track target destination URL if Location header points to it
            if (location) {
              let resolvedLoc = location;
              try {
                resolvedLoc = new URL(location, resUrl).href;
              } catch {}
              if (this._isDestinationUrl(location, url) || this._isDestinationUrl(resolvedLoc, url)) {
                capturedDestinationUrl = resolvedLoc;
              }
            }
          } else if (status >= 200 && status < 300) {
            if (this._isDestinationUrl(resUrl, url)) {
              capturedDestinationUrl = resUrl;
            }
          }
        } catch {}
      });

      const page = await context.newPage();

      // Monitor Socket.IO / WebSocket connection events with credentials redacted
      page.on('websocket', (ws) => {
        try {
          diagnosticLog.push({
            type: 'socket_connect',
            url: redactSecret(ws.url()),
            timestamp: Date.now(),
          });

          ws.on('framereceived', ({ payload }) => {
            diagnosticLog.push({
              type: 'socket_frame_received',
              payload: redactSecret(typeof payload === 'string' ? payload : '[Binary Frame]'),
              timestamp: Date.now(),
            });
          });

          ws.on('framesent', ({ payload }) => {
            diagnosticLog.push({
              type: 'socket_frame_sent',
              payload: redactSecret(typeof payload === 'string' ? payload : '[Binary Frame]'),
              timestamp: Date.now(),
            });
          });

          ws.on('close', () => {
            diagnosticLog.push({
              type: 'socket_close',
              timestamp: Date.now(),
            });
          });
        } catch {}
      });

      logger.discovered?.(`[AssistedResolver] Opening assisted session for: ${url}`);
      const navTimeout = Math.min(this.timeoutMs, this.navigationTimeoutMs);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      } catch (err) {
        const isTimeout = err.name === 'TimeoutError' || err.message?.includes('timeout');
        const errorMsg = isTimeout
          ? `Initial navigation timed out after ${navTimeout}ms`
          : `Navigation failed: ${err.message}`;

        console.warn(`\n⚠️ [AssistedResolver] ${errorMsg}`);
        return {
          originalUrl: url,
          finalUrl: null,
          httpStatus: latestHttpStatus || 0,
          pageTitle: '',
          redirectChain,
          cookies: await context.cookies().catch(() => []),
          diagnosticLog,
          error: errorMsg,
        };
      }

      // Bring to front to ensure timers and window focus listeners continue
      await page.bringToFront().catch(() => {});

      // Challenge selectors for Cloudflare Turnstile / Captcha
      const challengeSelectors = [
        '#turnstileContainer',
        '.cf-turnstile',
        'iframe[src*="turnstile"]',
        'iframe[src*="challenges.cloudflare.com"]',
        '#challenge-running',
        '#challenge-stage',
        '.cf-challenge',
        '#captcha',
        '.g-recaptcha',
        '.h-captcha',
      ];

      let hasPromptedChallenge = false;
      let buttonWasClicked = false;
      let destinationFound = false;

      const goBtn = page.locator(
        '#goToLinkBtn, a:has-text("Go to Link"), button:has-text("Go to Link"), a:has-text("Get Link"), button:has-text("Get Link")'
      );
      const startTime = Date.now();

      while (Date.now() - startTime < this.timeoutMs) {
        // 1. Check if destination was already reached on any open tab/page
        for (const p of context.pages()) {
          const pUrl = p.url();
          if (this._isDestinationUrl(pUrl, url)) {
            capturedDestinationUrl = pUrl;
            destinationFound = true;
            break;
          }
        }
        if (destinationFound) break;

        // 2. Dynamically trigger Step 1: #generateBtn (when visible and unhidden)
        const genBtn = page.locator('#generateBtn');
        if (await genBtn.isVisible({ timeout: 100 }).catch(() => false)) {
          const isHidden = await genBtn.evaluate((el) => el.classList.contains('hidden')).catch(() => false);
          const isDisabled = await genBtn.isDisabled().catch(() => true);
          if (!isHidden && !isDisabled) {
            logger.discovered?.('[AssistedResolver] Clicking "Generate Link"...');
            await genBtn.click().catch(() => {});
          }
        }

        // 3. Dynamically trigger Step 2: #continueBtn (when timer finishes and button is unhidden)
        const contBtn = page.locator('#continueBtn');
        if (await contBtn.isVisible({ timeout: 100 }).catch(() => false)) {
          const isHidden = await contBtn.evaluate((el) => el.classList.contains('hidden')).catch(() => false);
          if (!isHidden) {
            logger.discovered?.('[AssistedResolver] Step 1 timer finished. Clicking "Continue to Step 2"...');
            await contBtn.click().catch(() => {});
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await page.bringToFront().catch(() => {});
          }
        }

        // 4. Check for Turnstile / Verification Challenge
        // IMPORTANT: Strictly do NOT automate or bypass the verification challenge.
        let currentHasChallenge = false;
        for (const sel of challengeSelectors) {
          if (await page.locator(sel).first().isVisible({ timeout: 100 }).catch(() => false)) {
            currentHasChallenge = true;
            break;
          }
        }

        if (currentHasChallenge && !hasPromptedChallenge) {
          hasPromptedChallenge = true;
          console.log('\n================================================================');
          console.log('👉 [HUMAN VERIFICATION REQUIRED]:');
          console.log('   A verification challenge is displayed in the browser window.');
          console.log('   Please complete the challenge verification manually.');
          console.log('   (Automated solving is disabled per compliance policy.)');
          console.log('================================================================\n');
        }

        // 5. Trigger final navigation once human verification unlocks the Go to Link button
        if (!buttonWasClicked && (await goBtn.first().isVisible({ timeout: 100 }).catch(() => false))) {
          const isDisabled = await goBtn.first().isDisabled().catch(() => true);
          const isHidden = await goBtn.first().evaluate((el) => el.classList.contains('hidden')).catch(() => false);
          if (!isDisabled && !isHidden) {
            logger.discovered?.('[AssistedResolver] Verification cleared! Proceeding with destination navigation...');
            buttonWasClicked = true;
            try {
              await Promise.all([
                page.waitForNavigation({ timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => {}),
                goBtn.first().click().catch(() => {}),
              ]);
            } catch {
              // Navigation settled asynchronously
            }
          }
        }

        // If unlock button was clicked, allow short settle time for redirect to land
        if (buttonWasClicked) {
          const settleStart = Date.now();
          while (Date.now() - settleStart < 5000) {
            for (const p of context.pages()) {
              const pUrl = p.url();
              if (this._isDestinationUrl(pUrl, url)) {
                capturedDestinationUrl = pUrl;
                destinationFound = true;
                break;
              }
            }
            if (destinationFound) break;
            await page.waitForTimeout(500);
          }
          break;
        }

        await page.waitForTimeout(500);
      }

      // If destination was captured in redirect chain
      if (!destinationFound && capturedDestinationUrl) {
        destinationFound = true;
      }

      // Retrieve preserved cookies and active page metadata
      const cookies = await context.cookies().catch(() => []);
      const activePage = context.pages().slice(-1)[0] || page;
      const finalPageUrl = activePage.url();
      const pageTitle = await activePage.title().catch(() => '');

      // Check if destination was not returned
      if (!destinationFound && !this._isDestinationUrl(finalPageUrl, url)) {
        const errorMsg = 'No destination issued by server for this verified session.';
        console.warn(`\n⚠️ [AssistedResolver] ${errorMsg}\n`);

        return {
          originalUrl: url,
          finalUrl: null,
          httpStatus: latestHttpStatus || 0,
          pageTitle,
          redirectChain,
          cookies,
          diagnosticLog,
          error: errorMsg,
        };
      }

      const finalUrl = capturedDestinationUrl || finalPageUrl;

      return {
        originalUrl: url,
        finalUrl,
        httpStatus: latestHttpStatus || 200,
        pageTitle,
        redirectChain,
        cookies,
        diagnosticLog,
        error: null,
      };
    } catch (err) {
      console.warn(`\n⚠️ [AssistedResolver] Session error: ${err.message}\n`);
      return {
        originalUrl: url,
        finalUrl: null,
        httpStatus: 0,
        pageTitle: '',
        redirectChain,
        cookies: [],
        diagnosticLog,
        error: `Assisted session error: ${err.message}`,
      };
    } finally {
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }
}
