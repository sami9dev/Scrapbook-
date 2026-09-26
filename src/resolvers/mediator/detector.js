import { isHubCloudDriveUrl } from '../../providers/hubcloud/validator.js';

/**
 * Inspection and detection utilities for mediator pages running in Playwright or Cheerio.
 * Strictly adheres to Sections 8, 9, 10, 12, and 14 of the specification.
 */

export const CAPTCHA_SIGNATURES = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '.cf-turnstile',
  '#challenge-stage',
  '#turnstile-wrapper',
  '.g-recaptcha',
  '.h-captcha',
];

export const GET_LINK_PATTERNS = [
  /get\s*links?/i,
  /get\s*download\s*links?/i,
  /generate\s*links?/i,
  /go\s*to\s*download/i,
  /continue\s*to\s*links?/i,
  /download\s*links?/i,
  /fast\s*cloud\s*download/i,
];

export const VERIFY_PATTERNS = [
  /click\s*to\s*continue/i,
  /verify\s*to\s*continue/i,
  /start\s*verification/i,
  /please\s*click\s*here/i,
  /click\s*here\s*to\s*continue/i,
];

/**
 * Checks whether the current page context exhibits a human verification challenge.
 * NEVER attempts to solve or bypass.
 * 
 * @param {import('playwright').Page} page
 * @returns {Promise<{ isChallenge: boolean, reason?: string }>}
 */
export async function detectChallengeInPage(page) {
  try {
    return await page.evaluate((signatures) => {
      // 1. Check known challenge DOM elements
      for (const sig of signatures) {
        const el = document.querySelector(sig);
        if (el && el.offsetParent !== null) {
          return { isChallenge: true, reason: `Found challenge selector: ${sig}` };
        }
      }

      // 2. Check title / text indicators
      const title = document.title || '';
      const text = document.body ? document.body.innerText.slice(0, 3000) : '';

      const challengeIndicators = [
        'just a moment...',
        'attention required!',
        'checking if the site connection is secure',
        'please verify you are a human',
        'verify you are human',
        'cloudflare turnstile',
      ];

      for (const ind of challengeIndicators) {
        if (title.toLowerCase().includes(ind) || text.toLowerCase().includes(ind)) {
          return { isChallenge: true, reason: `Found security phrase: "${ind}"` };
        }
      }

      return { isChallenge: false };
    }, CAPTCHA_SIGNATURES);
  } catch (err) {
    return { isChallenge: false, error: err.message };
  }
}

/**
 * Inspects whether a timer/countdown is active in the page DOM.
 * 
 * @param {import('playwright').Page} page
 * @returns {Promise<{ hasTimer: boolean, secondsRemaining: number|null, isFinished: boolean }>}
 */
export async function detectCountdownInPage(page) {
  try {
    return await page.evaluate(() => {
      // Look for elements with typical countdown IDs/classes or circular progress counters
      const timerEls = Array.from(document.querySelectorAll(
        '#timer, .timer, #countdown, .countdown, [id*="counter"], [class*="counter"], [id*="timer"], [data-seconds], circle + text, svg + div'
      ));

      let secondsRemaining = null;
      let hasTimer = false;

      for (const el of timerEls) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const text = el.innerText.trim();
        const numMatch = text.match(/\b(\d{1,3})\b/);
        if (numMatch) {
          hasTimer = true;
          const val = parseInt(numMatch[1], 10);
          if (secondsRemaining === null || val > secondsRemaining) {
            secondsRemaining = val;
          }
        }
      }

      // Check if button currently says "PLEASE WAIT..."
      const waitButton = Array.from(document.querySelectorAll('button, a, .btn')).find((el) => (
        /please\s*wait/i.test(el.innerText || '')
      ));

      if (waitButton) {
        hasTimer = true;
      }

      // Check for standalone numbers (like circular countdown '9', '8'...)
      if (!hasTimer) {
        const allHeadingsAndSpans = Array.from(document.querySelectorAll('h1, h2, h3, h4, span, div'));
        for (const el of allHeadingsAndSpans) {
          const t = el.innerText ? el.innerText.trim() : '';
          if (/^\d{1,2}$/.test(t) && el.children.length === 0) {
            const val = parseInt(t, 10);
            if (val >= 0 && val <= 60) {
              hasTimer = true;
              secondsRemaining = val;
              break;
            }
          }
        }
      }

      // Fallback: check general body text for "wait X seconds"
      if (!hasTimer && document.body) {
        const waitMatch = document.body.innerText.match(/wait\s+(\d{1,3})\s*(?:s|sec|seconds)?/i);
        if (waitMatch) {
          hasTimer = true;
          secondsRemaining = parseInt(waitMatch[1], 10);
        }
      }

      const isFinished = waitButton ? false : (hasTimer ? secondsRemaining === 0 : true);

      return {
        hasTimer,
        secondsRemaining,
        isFinished,
      };
    });
  } catch {
    return { hasTimer: false, secondsRemaining: null, isFinished: true };
  }
}

/**
 * Detects whether the "Get Link" action is available and clickable in the page DOM.
 * 
 * @param {import('playwright').Page} page
 * @returns {Promise<{
 *   available: boolean,
 *   type?: 'link' | 'button' | 'input',
 *   href?: string|null,
 *   text?: string,
 *   selector?: string
 * }>}
 */
export async function detectGetLinkControl(page) {
  try {
    return await page.evaluate((patterns) => {
      const candidates = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));

      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];

        // Ensure visibility and interactive state
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
          continue;
        }

        if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled')) {
          continue;
        }

        const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
        const id = el.id ? `#${el.id}` : '';
        const className = el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : '';

        // Match against patterns
        const matches = patterns.some((pStr) => new RegExp(pStr, 'i').test(text));
        if (matches) {
          const isAnchor = el.tagName.toLowerCase() === 'a';
          const href = isAnchor ? el.getAttribute('href') : null;

          // Unique selector generator for clicking
          let selector = '';
          if (el.id) {
            selector = `#${el.id}`;
          } else {
            // Mark element with temporary test attribute for stable selector
            el.setAttribute('data-getlink-target', 'true');
            selector = '[data-getlink-target="true"]';
          }

          return {
            available: true,
            type: isAnchor ? 'link' : 'button',
            href: href || null,
            text,
            selector,
          };
        }
      }

      return { available: false };
    }, GET_LINK_PATTERNS.map((p) => p.source));
  } catch {
    return { available: false };
  }
}

/**
 * Detects whether an initial verification/continue control is present that requires a click
 * to begin or advance the mediator sequence.
 * 
 * @param {import('playwright').Page} page
 * @returns {Promise<{
 *   available: boolean,
 *   type?: 'link' | 'button' | 'input',
 *   text?: string,
 *   selector?: string
 * }>}
 */
export async function detectVerifyControl(page) {
  try {
    return await page.evaluate((patterns) => {
      const candidates = Array.from(document.querySelectorAll('#verify_btn, [id*="verify"], a, button, input[type="button"], input[type="submit"]'));

      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
          continue;
        }

        if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled')) {
          continue;
        }

        const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();

        // Do not match if element currently says "PLEASE WAIT" or "GET LINK"
        if (/please\s*wait/i.test(text) || /get\s*links?/i.test(text)) {
          continue;
        }

        const isVerifyBtnId = el.id === 'verify_btn' || /^verify/i.test(el.id);
        const matchesText = patterns.some((pStr) => new RegExp(pStr, 'i').test(text));

        if (isVerifyBtnId || matchesText) {
          const isAnchor = el.tagName.toLowerCase() === 'a';
          let selector = '';
          if (el.id) {
            selector = `#${el.id}`;
          } else {
            el.setAttribute('data-verify-target', 'true');
            selector = '[data-verify-target="true"]';
          }

          return {
            available: true,
            type: isAnchor ? 'link' : 'button',
            text,
            selector,
          };
        }
      }

      return { available: false };
    }, VERIFY_PATTERNS.map((p) => p.source));
  } catch {
    return { available: false };
  }
}

export default {
  detectChallengeInPage,
  detectCountdownInPage,
  detectGetLinkControl,
  detectVerifyControl,
  CAPTCHA_SIGNATURES,
  GET_LINK_PATTERNS,
  VERIFY_PATTERNS,
};
