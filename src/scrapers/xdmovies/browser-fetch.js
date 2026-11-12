/**
 * XDMovies Browser Fetcher with Cloudflare Turnstile Bypass
 *
 * Uses Scrapling Stealth (with automatic Turnstile bypass) and Playwright/Patchright fallback
 * to fetch full XDMovies pages with all client-side rendered download cards and links.
 */

if (process.platform !== 'win32') {
  process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';
}

import { chromium } from 'patchright';
import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../logging/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRAPLING_PYTHON = process.env.SCRAPLING_PYTHON || (process.platform === 'win32' ? 'C:\\Users\\sk621\\AppData\\Roaming\\uv\\tools\\scrapling\\Scripts\\python.exe' : 'python3');
const SCRAPLING_FETCH = path.join(__dirname, 'scrapling_fetch.py');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches page HTML by first attempting Scrapling stealth session (solving Cloudflare),
 * and falling back to a stealth Playwright browser if needed.
 *
 * @param {string} url - Target XDMovies URL to fetch
 * @param {object} [options]
 * @param {number} [options.timeoutMs=70000] - Total timeout
 * @param {boolean} [options.headless=true] - Headless mode
 * @returns {Promise<{ success: boolean, html: string, finalUrl: string, error?: string }>}
 */
export async function fetchXDMoviesPage(url, options = {}) {
  const timeoutMs = options.timeoutMs || 70000;
  logger.discovered(`[XDMovies] Navigating stealth resolver to: ${url}`);

  // ── Strategy A: Scrapling Stealth Python Worker (Solves Cloudflare Turnstile automatically)
  try {
    logger.log('XDMovies', `[XDMovies] Fetching via Scrapling Stealth (Headless)...`);
    const scrapResult = await new Promise((resolve) => {
      let child = execFile(
        SCRAPLING_PYTHON,
        [SCRAPLING_FETCH, url],
        {
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 50 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ success: false, error: error.message });
            return;
          }
          try {
            const lines = stdout.trim().split('\n');
            const lastLine = lines[lines.length - 1];
            resolve(JSON.parse(lastLine));
          } catch (e) {
            resolve({ success: false, error: 'Failed to parse scrapling fetch output' });
          }
        }
      );
    });

    if (scrapResult && scrapResult.success && scrapResult.html && scrapResult.html.length > 500) {
      logger.log('XDMovies', `[XDMovies] Scrapling fetch successful (HTML len: ${scrapResult.html.length})`);
      return {
        success: true,
        html: scrapResult.html,
        finalUrl: url,
      };
    }
  } catch (scrapErr) {
    logger.warning(`[XDMovies] Scrapling fetch error: ${scrapErr.message}, falling back to Chromium`);
  }

  // ── Strategy B: Stealth Chromium Fallback
  let browser = null;
  try {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--enable-blink-features=FakeShadowRoot',
    ];
    browser = await chromium.launch({
      headless: true,
      args: launchArgs,
    });

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
      const lowerTitle = title.toLowerCase();
      if (!lowerTitle.includes('just a moment') && !lowerTitle.includes('security verification') && !lowerTitle.includes('attention required')) {
        break;
      }

      logger.log('XDMovies', `[XDMovies] Cloudflare challenge detected (attempt ${attempt + 1}), finding Turnstile widget...`);

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
                break;
              }
            }
          } catch {}
        }
      } catch {}

      await sleep(2500);
    }

    // Wait for download links, episode cards, or catalog post cards to render
    if (!page.isClosed()) {
      try {
        await page.waitForSelector(
          '.download-item, .pack-card, .episode-card, a[href*="link.xdmovies"], .movie-download-btn, .download-button, a[href*="/movies/"], a[href*="/series/"]',
          { timeout: 12000 }
        );
      } catch {}
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
