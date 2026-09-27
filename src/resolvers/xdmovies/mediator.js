import { chromium } from 'playwright';
import { isHubCloudDriveUrl, extractHubCloudDriveId } from '../../providers/hubcloud/validator.js';
import { detectChallengeInPage } from '../mediator/detector.js';
import { logger } from '../../logging/logger.js';

/**
 * Resolves an XDMovies download redirect link into its mediator URL.
 * e.g. https://link.xdmovies.wtf/download/<id> -> https://latestnewsonline.sbs/r/<code>
 * 
 * @param {string} redirectUrl 
 * @returns {Promise<string|null>}
 */
export async function getXDMoviesMediatorUrl(redirectUrl) {
  if (!redirectUrl || typeof redirectUrl !== 'string') return null;

  // If already a mediator URL or HubCloud URL, return directly
  if (redirectUrl.includes('latestnewsonline.') || isHubCloudDriveUrl(redirectUrl)) {
    return redirectUrl;
  }

  try {
    const res = await fetch(redirectUrl, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://top.xdmovies.wtf/',
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        logger.resolver(`[XDMovies] Resolved redirect: ${redirectUrl} -> ${location}`);
        return location;
      }
    }

    return null;
  } catch (err) {
    logger.error(`[XDMovies] Error resolving download redirect ${redirectUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Resolves an XDMovies mediator URL (latestnewsonline.sbs/r/...) through Step 1 and Step 2
 * into the final HubCloud drive destination.
 * 
 * Follows anti-bot guidelines: If Cloudflare Turnstile appears, pauses safely
 * for human completion.
 * 
 * @param {string} mediatorUrl 
 * @param {object} [options]
 * @param {object} [options.meta]
 * @param {number} [options.stepTimeout] Default 25000ms
 * @param {boolean} [options.headless] Default true
 * @param {import('playwright').Browser} [options.existingBrowser]
 * @returns {Promise<{
 *   success: boolean,
 *   destination: string|null,
 *   driveId: string|null,
 *   state: string,
 *   error: string|null,
 *   meta: object
 * }>}
 */
export async function resolveXDMoviesMediator(mediatorUrl, options = {}) {
  const meta = options.meta || {};
  const headless = options.headless !== undefined ? options.headless : true;
  const stepTimeout = options.stepTimeout || 30000;

  // Check if already a HubCloud URL
  if (isHubCloudDriveUrl(mediatorUrl)) {
    return {
      success: true,
      destination: mediatorUrl,
      driveId: extractHubCloudDriveId(mediatorUrl),
      state: 'HUBCLOUD_DETECTED',
      error: null,
      meta,
    };
  }

  let browser = options.existingBrowser || null;
  let ownBrowser = false;
  let destinationUrl = null;

  try {
    if (!browser) {
      browser = await chromium.launch({
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      });
      ownBrowser = true;
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: {
        'Referer': 'https://link.xdmovies.wtf/',
      },
    });

    // Ensure timer continues in background by keeping tab active
    await context.addInitScript(() => {
      try {
        Object.defineProperty(document, 'hidden', { value: false, writable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
      } catch {}
    });

    // Abort noisy ad scripts and non-essential assets
    await context.route('**/*', (route) => {
      const req = route.request();
      const resourceType = req.resourceType();
      if (['image', 'font', 'media'].includes(resourceType)) {
        return route.abort();
      }
      const u = req.url();
      if (/admaven|propellerads|popads|alwingulla|adsterra|monetag|google-analytics|crn77\.com|dd133\.com/i.test(u)) {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();
    page.setDefaultTimeout(stepTimeout);

    // Monitor for HubCloud URL in any response or navigation
    page.on('response', (response) => {
      const u = response.url();
      if (isHubCloudDriveUrl(u)) {
        destinationUrl = u;
      }
    });

    logger.log('XDMOVIES_RESOLVER', `1. Navigating to mediator: ${mediatorUrl}`);
    await page.goto(mediatorUrl, { waitUntil: 'domcontentloaded', timeout: stepTimeout });

    // Check for initial Cloudflare challenge on mediator entrance
    const initialChallenge = await detectChallengeInPage(page);
    if (initialChallenge.isChallenge) {
      return {
        success: false,
        destination: null,
        driveId: null,
        state: 'CAPTCHA_REQUIRED',
        error: `Cloudflare challenge detected: ${initialChallenge.reason}`,
        meta,
      };
    }

    // Step 1: Wait for and click Generate Link button
    logger.log('XDMOVIES_RESOLVER', '2. Waiting for #generateBtn...');
    const generateBtn = await page.waitForSelector('#generateBtn', { timeout: 15000 }).catch(() => null);
    if (!generateBtn) {
      // Check if page already progressed to step 2 or direct link
      const curUrl = page.url();
      if (isHubCloudDriveUrl(curUrl)) {
        return {
          success: true,
          destination: curUrl,
          driveId: extractHubCloudDriveId(curUrl),
          state: 'HUBCLOUD_DETECTED',
          error: null,
          meta,
        };
      }
      return {
        success: false,
        destination: null,
        driveId: null,
        state: 'BUTTON_NOT_FOUND',
        error: 'Generate Link button not found on mediator page',
        meta,
      };
    }

    logger.log('XDMOVIES_RESOLVER', '3. Clicking #generateBtn...');
    await generateBtn.click();

    // Wait for Step 1 countdown: #continueBtn becomes visible
    logger.log('XDMOVIES_RESOLVER', '4. Waiting for Step 1 countdown to unlock #continueBtn...');
    const continueBtn = await page.waitForSelector('#continueBtn:not(.hidden)', { timeout: 20000 }).catch(() => null);
    if (!continueBtn) {
      return {
        success: false,
        destination: null,
        driveId: null,
        state: 'TIMEOUT',
        error: 'Step 1 countdown did not unlock #continueBtn within timeout',
        meta,
      };
    }

    logger.log('XDMOVIES_RESOLVER', '5. Clicking #continueBtn...');
    await continueBtn.click();

    // Step 2: Wait for page reload with step=2
    logger.log('XDMOVIES_RESOLVER', '6. Waiting for Step 2 page load...');
    await page.waitForURL(/step=2/, { timeout: 20000 }).catch(() => null);

    // Wait for Step 2 countdown to finish and Turnstile / #goToLinkBtn to appear
    logger.log('XDMOVIES_RESOLVER', '7. Waiting for Step 2 countdown to finish...');
    await page.waitForSelector('#turnstileContainer:not(.hidden), #goToLinkBtn:not(.hidden)', { timeout: 20000 }).catch(() => null);

    // Detect Turnstile challenge
    const turnstileWidget = await page.$('.cf-turnstile, #turnstileWidget, iframe[src*="challenges.cloudflare.com"]');
    if (turnstileWidget) {
      logger.log('XDMOVIES_RESOLVER', '8. Turnstile widget detected. Waiting for verification token...');
    }

    // Wait for #goToLinkBtn to become enabled (either auto-solved or via user interaction)
    const isLinkUnlocked = await page.waitForFunction(() => {
      const btn = document.getElementById('goToLinkBtn');
      return btn && !btn.disabled && !btn.classList.contains('hidden');
    }, { timeout: 60000 }).catch(() => null);

    if (!isLinkUnlocked) {
      return {
        success: false,
        destination: null,
        driveId: null,
        state: 'CAPTCHA_REQUIRED',
        error: 'Turnstile verification required on Step 2. Paused for human interaction.',
        meta,
      };
    }

    logger.log('XDMOVIES_RESOLVER', '9. #goToLinkBtn is enabled! Clicking to navigate...');
    await Promise.all([
      page.waitForNavigation({ timeout: 25000 }).catch(() => null),
      page.click('#goToLinkBtn'),
    ]);

    // Give brief time for final HubCloud redirection
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    logger.log('XDMOVIES_RESOLVER', `10. Page URL after final action: ${finalUrl}`);

    if (isHubCloudDriveUrl(finalUrl)) {
      destinationUrl = finalUrl;
    }

    if (destinationUrl && isHubCloudDriveUrl(destinationUrl)) {
      return {
        success: true,
        destination: destinationUrl,
        driveId: extractHubCloudDriveId(destinationUrl),
        state: 'HUBCLOUD_DETECTED',
        error: null,
        meta,
      };
    }

    return {
      success: false,
      destination: null,
      driveId: null,
      state: 'HUBCLOUD_DESTINATION_NOT_FOUND',
      error: 'Navigation did not yield a valid HubCloud drive destination',
      meta,
    };
  } catch (err) {
    logger.error(`[XDMovies] Error resolving mediator: ${err.message}`);
    return {
      success: false,
      destination: null,
      driveId: null,
      state: 'ERROR',
      error: err.message,
      meta,
    };
  } finally {
    if (ownBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}

export default {
  getXDMoviesMediatorUrl,
  resolveXDMoviesMediator,
};
