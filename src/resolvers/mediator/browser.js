import { chromium } from 'playwright';
import { isHubCloudDriveUrl } from '../../providers/hubcloud/validator.js';
import {
  detectChallengeInPage,
  detectCountdownInPage,
  detectGetLinkControl,
  detectVerifyControl,
  detectInvalidLinkInPage,
} from './detector.js';
import { extractEmbeddedMediatorPayload } from './http-first.js';
import { STATES, MediatorStateMachine } from './stateMachine.js';
import { logger } from '../../logging/logger.js';

/**
 * Resolves a dynamic mediator page into a final HubCloud drive destination.
 * Implements real browser automation following Sections 6, 7, 8, 9, 10, 11, 14, 15, and 16.
 * 
 * @param {string} mediatorUrl The dynamic mediator URL extracted from 4KHDHub
 * @param {object} [options]
 * @param {object} [options.meta] Context metadata (title, quality, sourceUrl, provider)
 * @param {number} [options.openTimeout] Timeout for loading mediator page (ms)
 * @param {number} [options.countdownTimeout] Timeout waiting for countdown/state transition (ms)
 * @param {number} [options.navigationTimeout] Timeout waiting for navigation to HubCloud (ms)
 * @param {boolean} [options.headless] Run headless (default true)
 * @param {import('playwright').Browser} [options.existingBrowser] Optional browser instance for testing
 * @returns {Promise<{
 *   success: boolean,
 *   state: string,
 *   destination: string|null,
 *   error: string|null,
 *   elapsedMs: number,
 *   meta: object,
 *   history: Array<object>
 * }>}
 */
export async function resolveMediatorFlow(mediatorUrl, options = {}) {
  const meta = {
    sourceUrl: options.meta?.sourceUrl || '',
    mediatorUrl,
    title: options.meta?.title || 'Unknown Title',
    quality: options.meta?.quality || 'unknown',
    provider: options.meta?.provider || 'HubCloud',
  };

  const sm = new MediatorStateMachine(meta);

  if (!mediatorUrl || typeof mediatorUrl !== 'string' || !mediatorUrl.startsWith('http')) {
    sm.transition(STATES.INVALID_MEDIATOR, { error: `Invalid mediator URL: ${mediatorUrl}` });
    return sm.getSummary();
  }

  // Check if mediator URL is somehow already the final destination
  if (isHubCloudDriveUrl(mediatorUrl)) {
    sm.transition(STATES.HUBCLOUD_DETECTED, { destination: mediatorUrl, info: 'Already a HubCloud destination URL' });
    return sm.getSummary();
  }

  // Fast HTTP pre-check: extract embedded payload without spinning up heavy browser
  try {
    const httpRes = await fetch(mediatorUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Referer': meta.sourceUrl || 'https://4khdhub.one/',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (httpRes.ok) {
      const htmlText = await httpRes.text();
      const directDest = extractEmbeddedMediatorPayload(htmlText);
      if (directDest && isHubCloudDriveUrl(directDest)) {
        logger.discovered(`[resolveMediatorFlow] Fast HTTP resolved HubCloud destination: ${directDest}`);
        sm.transition(STATES.HUBCLOUD_DETECTED, { destination: directDest, info: 'Decoded from embedded mediator payload (fast HTTP)' });
        return sm.getSummary();
      }
    }
  } catch {
    // Non-fatal, fallback to browser
  }

  const openTimeout = options.openTimeout || 25000;
  const countdownTimeout = options.countdownTimeout || 35000;
  const navigationTimeout = options.navigationTimeout || 20000;
  const headless = options.headless !== undefined ? options.headless : true;

  let browser = options.existingBrowser || null;
  let ownBrowser = false;

  try {
    if (!browser) {
      browser = await chromium.launch({
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      ownBrowser = true;
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    // Ensure timer continues in headless mode by reporting active visible tab
    await context.addInitScript(() => {
      try {
        Object.defineProperty(document, 'hidden', { value: false, writable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
      } catch {}
    });

    // Prevent aggressive ad networks from hijacking navigation or clicks, and abort non-essential assets
    await context.route('**/*', (route) => {
      const req = route.request();
      const resourceType = req.resourceType();
      if (['image', 'font', 'media'].includes(resourceType)) {
        return route.abort();
      }
      const reqUrl = req.url();
      if (/admaven|propellerads|popads|alwingulla|adsterra|monetag|google-analytics/i.test(reqUrl)) {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();
    page.setDefaultTimeout(openTimeout);

    // Track newly opened tabs/pages (Section 11: New-tab handling)
    const openedPages = [page];
    context.on('page', (newPage) => {
      openedPages.push(newPage);
      logger.log('MEDIATOR_BROWSER', `New tab/popup opened: ${newPage.url()}`);
    });

    // 1. MEDIATOR_OPEN
    sm.transition(STATES.MEDIATOR_OPEN, { info: `Navigating to ${mediatorUrl}` });

    try {
      await page.goto(mediatorUrl, { waitUntil: 'domcontentloaded', timeout: openTimeout });
    } catch (navErr) {
      sm.transition(STATES.NETWORK_ERROR, { error: `Failed to open mediator: ${navErr.message}` });
      return sm.getSummary();
    }

    // Check immediately for dead/invalid/expired link
    const initialInvalid = await detectInvalidLinkInPage(page);
    if (initialInvalid.isInvalid) {
      sm.transition(STATES.INVALID_LINK, {
        error: `Upstream mediator link is invalid or expired: ${initialInvalid.reason}`,
        info: 'Fast-fail: upstream link dead on source site / mediator host.',
      });
      return sm.getSummary();
    }

    // Check immediately for human verification challenge (Section 14: Hard boundary)
    const initialChallenge = await detectChallengeInPage(page);
    if (initialChallenge.isChallenge) {
      sm.transition(STATES.CAPTCHA_REQUIRED, {
        error: `Human verification required: ${initialChallenge.reason}`,
        info: 'Pausing resolver. No attempt made to defeat challenge.',
      });
      return sm.getSummary();
    }

    // Fast path: inspect HTML for embedded mediator destination payload (zero-wait)
    try {
      const pageHtml = await page.content();
      const directDest = extractEmbeddedMediatorPayload(pageHtml);
      if (directDest && isHubCloudDriveUrl(directDest)) {
        sm.transition(STATES.HUBCLOUD_DETECTED, {
          destination: directDest,
          info: 'Destination found directly from embedded mediator payload in page',
        });
        return sm.getSummary();
      }
    } catch {}

    // 2. WAITING / COUNTDOWN
    sm.transition(STATES.WAITING, { info: 'Page loaded, observing state transitions' });

    const countdownStart = Date.now();
    let getLinkControl = null;
    let timerObserved = false;
    let lastVerifyClickTime = 0;
    let lastClickedVerifyKey = '';

    while (Date.now() - countdownStart < countdownTimeout) {
      // Periodic dead/invalid link check
      const invalidCheck = await detectInvalidLinkInPage(page);
      if (invalidCheck.isInvalid) {
        sm.transition(STATES.INVALID_LINK, {
          error: `Upstream mediator link is invalid or expired: ${invalidCheck.reason}`,
          info: 'Fast-fail: upstream link dead on source site / mediator host.',
        });
        return sm.getSummary();
      }

      // Periodic challenge check
      const challenge = await detectChallengeInPage(page);
      if (challenge.isChallenge) {
        sm.transition(STATES.CAPTCHA_REQUIRED, {
          error: `Human verification challenge appeared during wait: ${challenge.reason}`,
        });
        return sm.getSummary();
      }

      // Check all active pages in case of instant redirect or early navigation
      for (const p of openedPages) {
        const currentUrl = p.url();
        if (isHubCloudDriveUrl(currentUrl)) {
          sm.transition(STATES.HUBCLOUD_DETECTED, {
            destination: currentUrl,
            info: 'HubCloud destination detected during wait phase',
          });
          return sm.getSummary();
        }
      }

      // Check if Get Link control has become available
      getLinkControl = await detectGetLinkControl(page);
      if (getLinkControl && getLinkControl.available) {
        break;
      }

      // Check for verify/continue action (supports multi-step: Step 1 -> Step 2 -> Get Link)
      const now = Date.now();
      if (now - lastVerifyClickTime > 2500) {
        const verifyControl = await detectVerifyControl(page);
        if (verifyControl && verifyControl.available) {
          const verifyKey = `${verifyControl.selector || ''}::${verifyControl.text || ''}`;
          if (verifyKey !== lastClickedVerifyKey || now - lastVerifyClickTime > 6000) {
            lastClickedVerifyKey = verifyKey;
            lastVerifyClickTime = now;
            logger.log('MEDIATOR', `Triggering mediator verification step: "${verifyControl.text}" (${verifyControl.selector})`);
            try {
              if (verifyControl.selector) {
                await page.click(verifyControl.selector, { timeout: 3000 }).catch(async () => {
                  await page.evaluate((sel) => {
                    const el = document.querySelector(sel) || document.getElementById('verify_btn');
                    if (el) el.click();
                  }, verifyControl.selector);
                });
              }
            } catch (vErr) {
              logger.warning(`Verification click error: ${vErr.message}`);
            }
          }
        }
      }

      // Check countdown timer state
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

    if (!getLinkControl || !getLinkControl.available) {
      if (timerObserved) {
        sm.transition(STATES.TIMEOUT, { error: `Timed out waiting for Get Link after countdown (${countdownTimeout}ms)` });
      } else {
        sm.transition(STATES.TIMEOUT, { error: `Get Link control was not found within ${countdownTimeout}ms` });
      }
      return sm.getSummary();
    }

    // 3. LINK_READY
    sm.transition(STATES.LINK_READY, {
      type: getLinkControl.type,
      text: getLinkControl.text,
      href: getLinkControl.href,
      info: `Get Link ready (${getLinkControl.type}: "${getLinkControl.text}")`,
    });

    // If anchor href is already the HubCloud destination, capture immediately
    if (getLinkControl.href && isHubCloudDriveUrl(getLinkControl.href)) {
      if ((!meta.title || meta.title === 'Unknown Title') && page) {
        try {
          await page.goto(getLinkControl.href, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
          const destTitle = await page.title();
          if (destTitle && !destTitle.toLowerCase().includes('just a moment')) {
            meta.title = destTitle.trim();
            meta.filename = destTitle.trim();
            sm.meta.title = destTitle.trim();
            sm.meta.filename = destTitle.trim();
          }
        } catch {}
      }
      sm.transition(STATES.HUBCLOUD_DETECTED, {
        destination: getLinkControl.href,
        info: 'Captured directly from Get Link href',
      });
      return sm.getSummary();
    }

    // 4. GET_LINK_ACTION
    sm.transition(STATES.GET_LINK_ACTION, {
      info: `Executing user action on ${getLinkControl.selector || 'Get Link'}`,
    });

    // Perform click on the verified Get Link control
    try {
      if (getLinkControl.selector) {
        await page.click(getLinkControl.selector, { timeout: 3000 }).catch(async () => {
          // Fallback to DOM click via evaluate if element had overlay
          await page.evaluate((sel) => {
            const el = document.querySelector(sel) || document.querySelector('[data-getlink-target="true"]');
            if (el) el.click();
          }, getLinkControl.selector);
        });
      }
    } catch (clickErr) {
      logger.warning(`Click encountered error: ${clickErr.message}`);
    }

    // 5. NAVIGATING
    sm.transition(STATES.NAVIGATING, { info: 'Observing navigation, tabs, and redirects' });

    const navStart = Date.now();
    let detectedUrl = null;

    while (Date.now() - navStart < navigationTimeout) {
      // Check all opened pages for HubCloud destination URL
      for (const p of openedPages) {
        const u = p.url();
        if (isHubCloudDriveUrl(u)) {
          detectedUrl = u;
          break;
        }
      }

      if (detectedUrl) break;

      // Also check if any page has navigated to an intermediate that now has a direct HubCloud anchor
      for (const p of openedPages) {
        try {
          const directHubLink = await p.evaluate(() => {
            const a = Array.from(document.querySelectorAll('a[href*="hubcloud."]')).find(el => el.href && el.href.includes('/drive/'));
            return a ? a.href : null;
          });
          if (directHubLink && isHubCloudDriveUrl(directHubLink)) {
            detectedUrl = directHubLink;
            break;
          }
        } catch {}
      }

      if (detectedUrl) break;

      // Allow brief settle for network redirects
      await page.waitForTimeout(500);
    }

    // 6. HUBCLOUD_DETECTED or HUBCLOUD_DESTINATION_NOT_FOUND
    if (detectedUrl && isHubCloudDriveUrl(detectedUrl)) {
      if ((!meta.title || meta.title === 'Unknown Title') && page) {
        try {
          const destTitle = await page.title();
          if (destTitle && !destTitle.toLowerCase().includes('just a moment')) {
            meta.title = destTitle.trim();
            meta.filename = destTitle.trim();
            sm.meta.title = destTitle.trim();
            sm.meta.filename = destTitle.trim();
          }
        } catch {}
      }
      sm.transition(STATES.HUBCLOUD_DETECTED, {
        destination: detectedUrl,
        info: `Successfully resolved destination: ${detectedUrl}`,
      });
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

export default {
  resolveMediatorFlow,
};
