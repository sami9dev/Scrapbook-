/**
 * XDMovies Browser Fetcher with Cloudflare Turnstile Bypass
 *
 * Uses Playwright with stealth flags to navigate XDMovies pages, automatically
 * detecting and solving Cloudflare Turnstile checkboxes when encountered,
 * and waiting for the client-side download cards/links to finish rendering.
 */

import { chromium } from 'patchright';
import { logger } from '../../logging/logger.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches page HTML by navigating a stealth browser tab and waiting for
 * Cloudflare Turnstile to clear and the page content to fully render.
 *
 * @param {string} url - Target XDMovies URL to fetch
 * @param {object} [options]
 * @param {number} [options.timeoutMs=35000] - Total navigation timeout
 * @param {boolean} [options.headless=true] - Headless mode
 * @returns {Promise<{ success: boolean, html: string, finalUrl: string, error?: string }>}
 */
export async function fetchXDMoviesPage(url, options = {}) {
  const timeoutMs = options.timeoutMs || 35000;
  const headless = options.headless !== undefined ? options.headless : true;

  logger.discovered(`[XDMovies] Navigating stealth browser to: ${url}`);

  let browser = null;
  try {
    // Launch Chrome with minimal, authentic flags
    const launchArgs = [
      '--disable-blink-features=AutomationControlled',
      '--enable-blink-features=FakeShadowRoot',
    ];
    try {
      browser = await chromium.launch({
        channel: 'chrome',
        headless,
        args: launchArgs,
      });
    } catch {
      browser = await chromium.launch({
        headless,
        args: launchArgs,
      });
    }

    const page = await browser.newPage();

    // Navigate to page
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (navErr) {
      if (navErr.message.includes('ERR_ABORTED') || navErr.message.includes('detached')) {
        await sleep(1000);
        await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs }).catch(() => {});
      } else {
        throw navErr;
      }
    }
    await sleep(3000);

    // Solve Cloudflare Turnstile if presented
    const startSolve = Date.now();
    let challengeCleared = false;
    let turnstileClicked = false;

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

    for (let attempt = 0; attempt < 12; attempt++) {
      if (page.isClosed()) break;
      let title = '';
      try {
        title = await page.title();
      } catch {
        break;
      }
      if (!title.toLowerCase().includes('just a moment')) {
        challengeCleared = true;
        break;
      }

      logger.log('XDMovies', `[XDMovies] Cloudflare challenge detected (attempt ${attempt + 1}), finding Turnstile widget...`);

      if (!turnstileClicked) {
        try {
          const cfFrames = page.frames().filter(
            (f) => (f.url() || '').includes('challenges.cloudflare') || (f.url() || '').includes('turnstile')
          );

          for (const frame of cfFrames) {
            try {
              const info = await frame.evaluate(FIND_CHECKBOX_JS).catch(() => null);
              if (info && info.found && info.w > 0 && !info.checked) {
                const frameEl = await frame.frameElement();
                const box = await frameEl.boundingBox();
                if (box) {
                  const clickX = box.x + info.x;
                  const clickY = box.y + info.y;
                  logger.log('XDMovies', `[XDMovies] Clicking Turnstile checkbox at (${Math.round(clickX)}, ${Math.round(clickY)})`);
                  await page.mouse.click(clickX, clickY);
                  turnstileClicked = true;
                  break;
                }
              } else if (!info || !info.found) {
                const frameEl = await frame.frameElement();
                const box = await frameEl.boundingBox();
                if (box && box.width > 50 && box.height > 30) {
                  const clickX = box.x + 28;
                  const clickY = box.y + box.height / 2;
                  logger.log('XDMovies', `[XDMovies] Clicking Turnstile checkbox at (${Math.round(clickX)}, ${Math.round(clickY)})`);
                  await page.mouse.click(clickX, clickY);
                  turnstileClicked = true;
                  break;
                }
              }
            } catch {
              // Frame may be navigating
            }
          }
        } catch {
          // Frames error
        }
      }

      await sleep(2500);
    }

    // Wait for download links, episode cards, or catalog post cards to render
    if (!page.isClosed()) {
      try {
        await page.waitForSelector(
          '.download-item, .pack-card, .episode-card, a[href*="link.xdmovies"], .movie-download-btn, .download-button, a[href*="/movies/"], a[href*="/series/"]',
          { timeout: 12000 }
        );
      } catch {
        // If selector times out, proceed with current DOM
      }

      // Small stabilization delay
      await sleep(1500);
    }

    const finalHtml = !page.isClosed() ? await page.content().catch(() => '') : '';
    const finalUrl = !page.isClosed() ? page.url() : url;

    return {
      success: true,
      html: finalHtml,
      finalUrl,
    };
  } catch (err) {
    logger.error(`[XDMovies] Browser fetch error for ${url}: ${err.message}`);
    return {
      success: false,
      html: '',
      finalUrl: url,
      error: err.message,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export default { fetchXDMoviesPage };
