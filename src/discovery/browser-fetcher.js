import { validateUrl } from '../utils/url.js';
import { detectHumanVerificationChallenge } from '../parsing/html-parser.js';
import { logger } from '../logging/logger.js';
import { config } from '../config/config.js';

let playwrightModule = null;

async function getPlaywright() {
  if (playwrightModule) return playwrightModule;
  try {
    playwrightModule = await import('playwright');
    return playwrightModule;
  } catch (err) {
    logger.warning(`Playwright could not be loaded: ${err.message}`);
    return null;
  }
}

/**
 * Renders an authorized JavaScript-heavy page using Playwright.
 * Used ONLY when HTTP parser cannot find the destination and normal JS rendering is required.
 * 
 * NEVER attempts to solve, bypass, or defeat CAPTCHA, Turnstile, or bot detection.
 * If challenge detected, immediately closes browser and reports HUMAN_VERIFICATION_REQUIRED.
 * 
 * @param {string} url
 * @param {object} options
 * @returns {Promise<{
 *   success: boolean,
 *   html?: string,
 *   finalUrl?: string,
 *   verificationRequired?: boolean,
 *   challengeResult?: object,
 *   error?: string
 * }>}
 */
export async function renderWithBrowser(url, options = {}) {
  const validation = validateUrl(url, {
    allowedDomains: options.allowedDomains ?? config.allowedDomains,
    allowInternal: options.allowInternal ?? false,
  });

  if (!validation.valid) {
    return {
      success: false,
      error: `Security error: ${validation.error}`,
    };
  }

  const pw = await getPlaywright();
  if (!pw || !pw.chromium) {
    return {
      success: false,
      error: 'Playwright chromium is not available in environment.',
    };
  }

  const timeoutMs = options.timeout ?? config.requestTimeout;
  let browser = null;

  try {
    logger.discovered(`Launching browser for authorized JS rendering: ${url}`);
    browser = await pw.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      userAgent: config.userAgent,
    });

    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    // SSRF Interceptor: abort requests to private/internal IPs during navigation
    await page.route('**/*', (route) => {
      const reqUrl = route.request().url();
      const check = validateUrl(reqUrl, {
        allowedDomains: options.allowedDomains ?? config.allowedDomains,
        allowInternal: options.allowInternal ?? false,
      });

      if (!check.valid) {
        logger.security(`Blocked browser request to internal/unauthorized address: ${reqUrl}`);
        route.abort();
      } else {
        route.continue();
      }
    });

    // Navigate to page
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Allow brief settle for authorized client scripts
    await page.waitForTimeout(1000);

    const renderedHtml = await page.content();
    const finalUrl = page.url();

    // Check for human verification challenges in the rendered DOM
    const challengeCheck = detectHumanVerificationChallenge(renderedHtml, finalUrl);
    if (challengeCheck.isChallenge) {
      logger.warning(`HUMAN_VERIFICATION_REQUIRED detected in browser DOM on ${finalUrl}. Stopping flow.`);
      return {
        success: false,
        verificationRequired: true,
        challengeResult: challengeCheck.result,
        finalUrl,
      };
    }

    return {
      success: true,
      html: renderedHtml,
      finalUrl,
      verificationRequired: false,
    };
  } catch (err) {
    logger.error(`Browser rendering failed on ${url}: ${err.message}`);
    return {
      success: false,
      error: err.message,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export default {
  renderWithBrowser,
};
