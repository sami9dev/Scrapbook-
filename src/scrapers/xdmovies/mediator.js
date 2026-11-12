/**
 * XDMovies Mediator Resolver
 *
 * Resolves XDMovies intermediary links (link.xdmovies.wtf / latestnewsonline.sbs)
 * through their multi-step countdown and Cloudflare Turnstile verification
 * into the final HubCloud Drive destination URL.
 */

if (process.platform !== 'win32') {
  process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';
}

import { chromium } from 'patchright';
import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../logging/logger.js';
import { isHubCloudDriveUrl, fetchHubCloudMetadata } from '../../providers/hubcloud/validator.js';
import { mediatorResolutionSemaphore } from '../../utils/concurrency.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRAPLING_PYTHON = process.env.SCRAPLING_PYTHON || (process.platform === 'win32' ? 'C:\\Users\\sk621\\AppData\\Roaming\\uv\\tools\\scrapling\\Scripts\\python.exe' : 'python3');
const SCRAPLING_RESOLVER = path.join(__dirname, 'scrapling_resolver.py');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason || new Error('Resolver request aborted'));
    return;
  }
  const timer = setTimeout(done, ms);
  function done() {
    signal?.removeEventListener('abort', abort);
    resolve();
  }
  function abort() {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    reject(signal.reason || new Error('Resolver request aborted'));
  }
  signal?.addEventListener('abort', abort, { once: true });
});

/**
 * Normalizes any HubCloud drive URL to canonical https://hubcloud.ist/drive/...
 *
 * @param {string} url
 * @returns {string}
 */
export function canonicalHubCloudUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const parsed = new URL(url.trim());
    if (parsed.pathname.startsWith('/drive/')) {
      return `https://hubcloud.pw${parsed.pathname}${parsed.search}`;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Resolves a mediator URL (link.xdmovies.wtf or latestnewsonline.sbs)
 * into a legitimate HubCloud drive destination.
 *
 * @param {string} mediatorUrl - The link to resolve
 * @param {object} [options]
 * @param {boolean} [options.headless=false] - Run headless (default false for Turnstile compatibility)
 * @param {number} [options.timeoutMs=45000] - Total navigation timeout
 * @param {import('playwright').Browser} [options.existingBrowser] - Optional reused browser
 * @param {AbortSignal} [options.signal] - Cancels child processes and browser work
 * @returns {Promise<{
 *   success: boolean,
 *   destination: string | null,
 *   error: string | null,
 *   metadata?: object | null,
 *   elapsedMs: number
 * }>}
 */
async function resolveXDMoviesMediatorUnlocked(mediatorUrl, options = {}) {
  const startedAt = Date.now();
  const normalizedUrl = (mediatorUrl || '').trim();
  const { signal } = options;
  const cancelledResult = () => ({
    success: false,
    destination: null,
    error: 'Resolution cancelled because the client request ended',
    metadata: null,
    elapsedMs: Date.now() - startedAt,
  });
  if (signal?.aborted) return cancelledResult();

  // If already a HubCloud URL, return canonical URL immediately (no synchronous metadata block)
  if (isHubCloudDriveUrl(normalizedUrl)) {
    const canonical = canonicalHubCloudUrl(normalizedUrl);
    return {
      success: true,
      destination: canonical,
      error: null,
      metadata: null,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const timeoutMs = options.timeoutMs || 70000;
  // Silent stealth background mode by default
  const headless = options.headless !== undefined ? options.headless : true;

  let browser = options.existingBrowser || null;
  let ownBrowser = false;

  // [OPT-3] One resolver strategy per request — avoids sequential Scrapling + Chromium attempts
  const chosenStrategy = options.strategy || process.env.RESOLVER_STRATEGY || (options.existingBrowser ? 'chromium' : 'scrapling');
  logger.log('TIMING', `[resolver choice] strategy=${chosenStrategy} url=${normalizedUrl}`);
  logger.log('XDMovies', `[XDMovies Mediator] Starting resolution for: ${normalizedUrl} using strategy: ${chosenStrategy}`);

  // Strategy A: Scrapling stealth headless resolver
  if (chosenStrategy === 'scrapling' && !options.existingBrowser) {
    try {
      logger.log('XDMovies', `[XDMovies Mediator] Resolving via Scrapling Stealth (Headless)...`);
      const scrapResult = await new Promise((resolve) => {
        let child;
        const terminateProcessTree = () => {
          if (!child?.pid) return;
          if (process.platform === 'win32') {
            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
            return;
          }
          try {
            process.kill(-child.pid, 'SIGINT');
          } catch {}
          const forceKillTimer = setTimeout(() => {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {}
          }, 1000);
          forceKillTimer.unref?.();
        };
        const onAbort = () => terminateProcessTree();

        child = execFile(
          SCRAPLING_PYTHON,
          [SCRAPLING_RESOLVER, normalizedUrl],
          {
            windowsHide: true,
            detached: process.platform !== 'win32',
            timeout: 125000, // Kill child before 130s hard deadline
            env: {
              ...process.env,
              ...(process.platform === 'win32' && process.env.PLAYWRIGHT_BROWSERS_PATH === '0'
                ? { PLAYWRIGHT_BROWSERS_PATH: undefined }
                : {}),
            },
          },
          (error, stdout, stderr) => {
            signal?.removeEventListener('abort', onAbort);
            if (error) {
              resolve({ success: false, error: error.message });
              return;
            }
            try {
              const lines = stdout.trim().split('\n');
              const lastLine = lines[lines.length - 1];
              resolve(JSON.parse(lastLine));
            } catch (e) {
              resolve({ success: false, error: 'Failed to parse scrapling resolver output' });
            }
          }
        );
        child.once('error', (error) => {
          if (error.killed || error.code === 'ETIMEDOUT') terminateProcessTree();
        });
        child.once('close', () => signal?.removeEventListener('abort', onAbort));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });

      if (signal?.aborted) return cancelledResult();

      if (scrapResult && scrapResult.isDead) {
        logger.log('XDMovies', `[XDMovies Mediator] Dead link detected (${scrapResult.error}). Fast aborting.`);
        return {
          success: false,
          isDead: true,
          destination: null,
          error: scrapResult.error || 'Link is dead or token not found (404)',
          elapsedMs: Date.now() - startedAt,
        };
      }

      if (scrapResult && scrapResult.success && scrapResult.destination) {
        const dest = canonicalHubCloudUrl(scrapResult.destination);
        return {
          success: true,
          destination: dest,
          error: null,
          metadata: scrapResult.metadata || null,
          elapsedMs: Date.now() - startedAt,
        };
      }

      // [OPT-3] Return Scrapling failure directly without running Chromium sequentially
      return {
        success: false,
        destination: null,
        error: scrapResult?.error || 'Scrapling resolution failed to reach HubCloud destination',
        metadata: null,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (scrapErr) {
      if (signal?.aborted) return cancelledResult();
      return {
        success: false,
        destination: null,
        error: `Scrapling execution failed: ${scrapErr.message}`,
        metadata: null,
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  if (signal?.aborted) return cancelledResult();

  const closeBrowserOnAbort = () => {
    if (ownBrowser && browser) void browser.close().catch(() => {});
  };
  signal?.addEventListener('abort', closeBrowserOnAbort, { once: true });

  try {
    if (!browser) {
      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--enable-blink-features=FakeShadowRoot',
        '--renderer-process-limit=1',
        '--js-flags=--max-old-space-size=128',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--mute-audio',
        '--no-zygote',
      ];
      try {
        browser = await chromium.launch({
          headless: true,
          args: launchArgs,
        });
      } catch (launchErr) {
        logger.error(`[XDMovies Mediator] Failed to launch browser: ${launchErr.message}`);
        throw launchErr;
      }
      ownBrowser = true;
    }
    if (signal?.aborted) return cancelledResult();

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    });

    let capturedDest = null;
    const checkCaptured = (u) => {
      if (u && isHubCloudDriveUrl(u)) {
        capturedDest = canonicalHubCloudUrl(u);
        return true;
      }
      return false;
    };

    context.on('page', (newPage) => {
      newPage.on('framenavigated', (frame) => {
        if (frame === newPage.mainFrame()) checkCaptured(frame.url());
      });
      newPage.on('request', (req) => checkCaptured(req.url()));
      checkCaptured(newPage.url());
    });

    const page = await context.newPage();
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) checkCaptured(frame.url());
    });
    page.on('request', (req) => checkCaptured(req.url()));

    // Block intrusive ad and push tracker scripts to prevent popup clutter and slow load times
    await page.route(/(push-sdk\.com|dd133\.com|crn77\.com|aqle3\.com|s0-greate\.net)/i, (route) => route.abort());

    // Ensure active tab focus & visibility and patch webdriver for stealth
    await page.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
        Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      } catch {}
    });

    // Capture completion response from /api/session/complete
    let completeApiResponse = null;
    page.on('response', async (res) => {
      const u = res.url();
      if (u.includes('/api/session/complete')) {
        try {
          const bodyText = await res.text();
          completeApiResponse = JSON.parse(bodyText);
        } catch {}
      }
    });

    // Helper: Turnstile solver using FakeShadowRoot closed-tree discovery
    const FIND_CHECKBOX_JS = `() => {
      function find(root) {
        if (!root) return null;
        const direct = root.querySelector && root.querySelector('input[type=checkbox]');
        if (direct) return direct;
        for (const el of (root.querySelectorAll ? root.querySelectorAll('*') : [])) {
          const sr = el.fakeShadowRoot || el.shadowRoot;
          if (sr) { const r = find(sr); if (r) return r; }
        }
        return null;
      }
      const cb = find(document);
      if (!cb) return { found: false };
      const r = cb.getBoundingClientRect();
      return { found: true, checked: !!cb.checked, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
    }`;

    let turnstileClicked = false;
    async function solveTurnstile() {
      if (turnstileClicked) return false;
      const frames = page.frames().filter(
        (f) => (f.url() || '').includes('challenges.cloudflare') || (f.url() || '').includes('turnstile')
      );
      for (const frame of frames) {
        try {
          const info = await frame.evaluate(FIND_CHECKBOX_JS).catch(() => null);
          if (info && info.found && info.w > 0 && !info.checked) {
            const frameEl = await frame.frameElement();
            const box = await frameEl.boundingBox();
            if (box) {
              const clickX = box.x + info.x;
              const clickY = box.y + info.y;
              logger.log('XDMovies', `[XDMovies Mediator] Clicking Turnstile checkbox at (${Math.round(clickX)}, ${Math.round(clickY)})`);
              await page.mouse.click(clickX, clickY);
              turnstileClicked = true;
              return true;
            }
          } else if (!info || !info.found) {
            // Fallback to bounding box click if frame is present but shadow inspection pending
            const frameEl = await frame.frameElement();
            const box = await frameEl.boundingBox();
            if (box && box.width > 50 && box.height > 30) {
              const cx = box.x + 28;
              const cy = box.y + box.height / 2;
              logger.log('XDMovies', `[XDMovies Mediator] Clicking Turnstile at (${Math.round(cx)}, ${Math.round(cy)})`);
              await page.mouse.click(cx, cy);
              turnstileClicked = true;
              return true;
            }
          }
        } catch {}
      }
      return false;
    }

    // Step 1: Navigate to mediator start link (link.xdmovies.wtf or latestnewsonline.sbs)
    try {
      await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (navErr) {
      if (navErr.message.includes('ERR_ABORTED') || navErr.message.includes('detached')) {
        await sleep(1200, signal);
        await page.goto(normalizedUrl, { waitUntil: 'commit', timeout: timeoutMs }).catch(() => {});
      } else {
        throw navErr;
      }
    }
    await page.bringToFront().catch(() => {});

    // Loop until we reach latestnewsonline.sbs and clear initial Cloudflare challenges
    let reachedMediatorPage = false;
    for (let i = 0; i < 20; i++) {
      if (page.isClosed()) break;
      const curUrl = page.url();
      let title = '';
      try {
        title = await page.title();
      } catch {
        break;
      }

      // Check if already reached Hubcloud (e.g. from fast redirect)
      if (capturedDest || isHubCloudDriveUrl(curUrl)) {
        break;
      }

      if (
        (curUrl.includes('latestnewsonline.sbs') || curUrl.includes('link.xdmovies.')) &&
        !title.toLowerCase().includes('just a moment') &&
        !title.toLowerCase().includes('loading http')
      ) {
        const hasGenBtn = await page.$('#generateBtn, #continueBtn, #turnstileContainer, #goToLinkBtn').catch(() => null);
        if (hasGenBtn || curUrl.includes('/r/')) {
          reachedMediatorPage = true;
          break;
        }
      }

      await solveTurnstile();
      await sleep(2000, signal);
    }

    if (!reachedMediatorPage && !capturedDest && !isHubCloudDriveUrl(page.url())) {
      throw new Error(`Failed to land on mediator page: ${page.url()}`);
    }

    // Check if directly redirected to Hubcloud
    if (capturedDest || isHubCloudDriveUrl(page.url())) {
      const dest = capturedDest || canonicalHubCloudUrl(page.url());
      let metadata = null;
      try {
        metadata = await fetchHubCloudMetadata(dest);
      } catch {}
      return {
        success: true,
        destination: dest,
        error: null,
        metadata,
        elapsedMs: Date.now() - startedAt,
      };
    }

    // Step 2: Click #generateBtn
    logger.log('XDMovies', '[XDMovies Mediator] Step 1: Checking and clicking #generateBtn...');
    try {
      const genBtn = await page.waitForSelector('#generateBtn', { timeout: 15000 });
      if (genBtn) {
        await sleep(1000, signal);
        await page.evaluate(() => {
          const btn = document.getElementById('generateBtn');
          if (btn) btn.click();
        });
      }
    } catch {
      logger.log('XDMovies', '[XDMovies Mediator] #generateBtn step skipped or not needed.');
    }

    // Step 3: Wait for Step 1 countdown (6s)
    logger.log('XDMovies', '[XDMovies Mediator] Waiting for Step 1 countdown...');
    try {
      let continueVisible = await page.waitForSelector('#continueBtn:not(.hidden), #continueBtn', { timeout: 20000 }).catch(() => null);
      if (!continueVisible) {
        await page.evaluate(() => {
          const btn = document.getElementById('generateBtn');
          if (btn) btn.click();
        }).catch(() => {});
        continueVisible = await page.waitForSelector('#continueBtn:not(.hidden), #continueBtn', { timeout: 25000 }).catch(() => null);
      }
      if (continueVisible) {
        logger.log('XDMovies', '[XDMovies Mediator] Step 1 finished! Clicking #continueBtn...');
        await page.evaluate(() => {
          const btn = document.getElementById('continueBtn');
          if (btn) btn.click();
        });
      }
    } catch {
      logger.log('XDMovies', '[XDMovies Mediator] #continueBtn step passed.');
    }

    // Step 4: Step 2 page reload (?step=2)
    logger.log('XDMovies', '[XDMovies Mediator] Step 2: Waiting for Step 2 page reload...');
    turnstileClicked = false;
    try {
      await page.waitForURL(
        (url) => (url.searchParams ? url.searchParams.get('step') === '2' : String(url).includes('step=2')),
        { waitUntil: 'domcontentloaded', timeout: 20000 }
      );
    } catch {
      if (!page.url().includes('step=2')) {
        await sleep(2000, signal);
      }
    }
    await page.bringToFront().catch(() => {});

    // Step 5: Wait for Step 2 countdown (6s) & #turnstileContainer
    logger.log('XDMovies', '[XDMovies Mediator] Waiting for Step 2 countdown and Turnstile container...');
    await page.waitForSelector('#turnstileContainer:not(.hidden)', { timeout: 20000 });

    // Buffer extra 8 seconds so the WebSocket heartbeat meets server-side duration requirement
    logger.log('XDMovies', '[XDMovies Mediator] Buffering server-side socket heartbeats...');
    await sleep(8000, signal);

    // Step 6: Wait for #goToLinkBtn to be enabled
    logger.log('XDMovies', '[XDMovies Mediator] Checking Turnstile solution and #goToLinkBtn readiness...');
    let buttonReady = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      if (page.isClosed()) break;
      const isEnabled = await page.evaluate(() => {
        const inp = document.querySelector('[name="cf-turnstile-response"]');
        if (inp && inp.value && typeof window.onTurnstileSuccess === 'function') {
          window.onTurnstileSuccess(inp.value);
        }
        const btn = document.getElementById('goToLinkBtn');
        return btn && !btn.disabled && !btn.classList.contains('hidden');
      }).catch(() => false);

      if (isEnabled) {
        buttonReady = true;
        break;
      }

      await solveTurnstile();
      await sleep(1500, signal);
    }

    if (!buttonReady) {
      throw new Error('#goToLinkBtn was not enabled within timeout.');
    }

    // Step 7: Click #goToLinkBtn (with retry if server timer is still buffering)
    logger.log('XDMovies', '[XDMovies Mediator] Clicking #goToLinkBtn...');
    for (let clickAttempt = 0; clickAttempt < 5; clickAttempt++) {
      completeApiResponse = null;
      await page.evaluate(() => {
        // Clean any overlapping ad modals
        const adModals = document.querySelectorAll('div[class*="modal"], div[class*="popup"], div[style*="z-index"]');
        const linkBtn = document.getElementById('goToLinkBtn');
        for (const m of adModals) {
          if (linkBtn && !m.contains(linkBtn)) {
            m.remove();
          }
        }
        const inp = document.querySelector('[name="cf-turnstile-response"]');
        if (inp && inp.value && typeof window.onTurnstileSuccess === 'function') {
          window.onTurnstileSuccess(inp.value);
        }
        if (linkBtn) linkBtn.click();
      });

      await sleep(3000, signal);

      // Check if page already redirected to Hubcloud
      if (isHubCloudDriveUrl(page.url())) {
        break;
      }

      if (completeApiResponse && completeApiResponse.token) {
        break;
      }

      if (completeApiResponse && completeApiResponse.error) {
        logger.log(
          'XDMovies',
          `[XDMovies Mediator] Server returned: "${completeApiResponse.error}". Retrying in 3s...`
        );
        await solveTurnstile();
        await sleep(3000, signal);
      }
    }

    // Step 8: Wait for final HubCloud destination URL
    logger.log('XDMovies', '[XDMovies Mediator] Waiting for final HubCloud destination navigation...');
    let finalDestination = capturedDest || null;
    for (let w = 0; w < 30; w++) {
      if (finalDestination) break;
      for (const p of context.pages()) {
        const pUrl = p.url();
        if (checkCaptured(pUrl)) {
          finalDestination = capturedDest;
          break;
        }
      }
      if (finalDestination) break;
      await sleep(1000, signal);
    }

    if (!finalDestination && isHubCloudDriveUrl(page.url())) {
      finalDestination = canonicalHubCloudUrl(page.url());
    }

    if (!finalDestination) {
      throw new Error(`Resolution timed out without landing on HubCloud. Final URL: ${page.url()}`);
    }

    // Ensure final link starts from https://hubcloud.ist/drive/
    try {
      const parsed = new URL(finalDestination);
      if (parsed.pathname.startsWith('/drive/')) {
        finalDestination = `https://hubcloud.pw${parsed.pathname}${parsed.search}`;
      }
    } catch {}

    logger.log('XDMovies', `[XDMovies Mediator] Successfully reached HubCloud: ${finalDestination}`);

    return {
      success: true,
      destination: finalDestination,
      error: null,
      metadata: null,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (signal?.aborted) return cancelledResult();
    logger.error(`[XDMovies Mediator] Resolution failed: ${err.message}`);
    return {
      success: false,
      destination: null,
      error: err.message,
      metadata: null,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    signal?.removeEventListener('abort', closeBrowserOnAbort);
    if (ownBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}

export async function resolveXDMoviesMediator(mediatorUrl, options = {}) {
  const queuedAt = Date.now();
  const normalizedUrl = (mediatorUrl || '').trim();
  if (isHubCloudDriveUrl(normalizedUrl)) {
    return resolveXDMoviesMediatorUnlocked(mediatorUrl, options);
  }

  const parsedTimeoutSeconds = Number.parseInt(process.env.REQUEST_TIMEOUT_SECONDS || '130', 10);
  const timeoutSeconds = Number.isFinite(parsedTimeoutSeconds) ? Math.max(1, parsedTimeoutSeconds) : 130;
  const timeoutMs = timeoutSeconds * 1000;
  const deadlineController = new AbortController();
  const relayCallerAbort = () => deadlineController.abort(options.signal?.reason);
  if (options.signal?.aborted) relayCallerAbort();
  else options.signal?.addEventListener('abort', relayCallerAbort, { once: true });
  const deadlineTimer = setTimeout(() => {
    deadlineController.abort(new Error(`Resolution timed out after ${timeoutSeconds} seconds`));
  }, timeoutMs);
  deadlineTimer.unref?.();
  const resolverOptions = { ...options, signal: deadlineController.signal };

  let release;
  try {
    release = await mediatorResolutionSemaphore.acquire(deadlineController.signal);
  } catch {
    const timedOut = !options.signal?.aborted;
    return {
      success: false,
      destination: null,
      error: timedOut ? `Resolution timed out after ${timeoutSeconds} seconds` : 'Resolution cancelled before a worker became available',
      metadata: null,
      elapsedMs: Date.now() - queuedAt,
    };
  } finally {
    if (!release) {
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener('abort', relayCallerAbort);
    }
  }

  try {
    const result = await resolveXDMoviesMediatorUnlocked(mediatorUrl, resolverOptions);
    if (deadlineController.signal.aborted && !options.signal?.aborted) {
      return {
        success: false,
        destination: null,
        error: `Resolution timed out after ${timeoutSeconds} seconds`,
        metadata: null,
        elapsedMs: Date.now() - queuedAt,
      };
    }
    result.elapsedMs = Date.now() - queuedAt;
    return result;
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', relayCallerAbort);
    release();
  }
}

export default { resolveXDMoviesMediator };
