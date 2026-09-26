import * as cheerio from 'cheerio';
import { resolveRelativeUrl } from '../utils/url.js';
import { logger } from '../logging/logger.js';

/**
 * Indicators of bot protection, CAPTCHA, or Cloudflare challenges in HTML content.
 */
const CHALLENGE_INDICATORS = [
  // Cloudflare Turnstile & Challenges
  { selector: '.cf-turnstile', type: 'Cloudflare Turnstile' },
  { selector: 'div[id*="cf-turnstile"]', type: 'Cloudflare Turnstile' },
  { selector: 'iframe[src*="challenges.cloudflare.com"]', type: 'Cloudflare Turnstile' },
  { selector: '#cf-challenge-running', type: 'Cloudflare Challenge' },
  { selector: '#challenge-stage', type: 'Cloudflare Challenge' },
  { selector: '#challenge-form', type: 'Cloudflare Challenge' },
  { text: 'Attention Required! | Cloudflare', type: 'Cloudflare Challenge' },
  { text: 'Just a moment...', type: 'Cloudflare Challenge' },
  { text: 'Checking your browser before accessing', type: 'Cloudflare Challenge' },
  { text: 'Verify you are human', type: 'Human Verification' },
  
  // Google reCAPTCHA
  { selector: '.g-recaptcha', type: 'reCAPTCHA' },
  { selector: 'iframe[src*="google.com/recaptcha"]', type: 'reCAPTCHA' },
  
  // hCaptcha
  { selector: '.h-captcha', type: 'hCaptcha' },
  { selector: 'iframe[src*="hcaptcha.com"]', type: 'hCaptcha' },
  
  // General Bot Detection
  { selector: '#bot-detection', type: 'Bot Detection' },
  { text: 'Please complete the security check to access', type: 'Security Challenge' },
];

/**
 * Inspects HTML to determine if a human verification challenge (Cloudflare, CAPTCHA, Turnstile) is present.
 * NEVER attempts to defeat or bypass challenges. Cleanly stops and reports HUMAN_VERIFICATION_REQUIRED.
 * 
 * @param {string} html
 * @param {string} url
 * @param {string} [provider]
 * @returns {{ isChallenge: boolean, result?: object }}
 */
export function detectHumanVerificationChallenge(html, url = '', provider = 'Unknown') {
  if (!html || typeof html !== 'string') {
    return { isChallenge: false };
  }

  const $ = cheerio.load(html);
  const title = $('title').text().trim();
  const pageText = $('body').text() || '';

  for (const indicator of CHALLENGE_INDICATORS) {
    if (indicator.selector && $(indicator.selector).length > 0) {
      logger.warning(`Human verification detected via selector [${indicator.selector}] on ${url}`);
      return {
        isChallenge: true,
        result: {
          status: 'HUMAN_VERIFICATION_REQUIRED',
          url,
          provider,
          message: 'Manual verification required.',
          challengeType: indicator.type,
        },
      };
    }

    if (indicator.text) {
      if (title.includes(indicator.text) || pageText.includes(indicator.text)) {
        logger.warning(`Human verification detected via text [${indicator.text}] on ${url}`);
        return {
          isChallenge: true,
          result: {
            status: 'HUMAN_VERIFICATION_REQUIRED',
            url,
            provider,
            message: 'Manual verification required.',
            challengeType: indicator.type,
          },
        };
      }
    }
  }

  return { isChallenge: false };
}

/**
 * Parses meta refresh tag to find automatic redirect URLs.
 * Example: <meta http-equiv="refresh" content="0; url=https://example.com/dest">
 * 
 * @param {cheerio.CheerioAPI} $
 * @param {string} baseUrl
 * @returns {string|null}
 */
export function extractMetaRefresh($, baseUrl) {
  const metaRefresh = $('meta[http-equiv="refresh" i]').attr('content');
  if (!metaRefresh) return null;

  const match = metaRefresh.match(/url\s*=\s*['"]?([^'";\s]+)['"]?/i);
  if (match && match[1]) {
    return resolveRelativeUrl(baseUrl, match[1]);
  }
  return null;
}

/**
 * Extracts the canonical URL from HTML.
 * 
 * @param {cheerio.CheerioAPI} $
 * @param {string} baseUrl
 * @returns {string|null}
 */
export function extractCanonicalUrl($, baseUrl) {
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical) {
    return resolveRelativeUrl(baseUrl, canonical);
  }
  return null;
}

/**
 * Extracts embedded JSON and JSON-LD from <script> tags.
 * 
 * @param {cheerio.CheerioAPI} $
 * @returns {Array<object>}
 */
export function extractJsonFromScripts($) {
  const jsonObjects = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const content = $(el).html();
      if (content) {
        const parsed = JSON.parse(content.trim());
        jsonObjects.push(parsed);
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  });

  // Also look for window.__INITIAL_DATA__ or similar plain JSON scripts
  $('script:not([src])').each((_, el) => {
    const text = $(el).html() || '';
    const jsonMatch = text.match(/(?:window\.__[A-Z0-9_]+__|var\s+data|const\s+data)\s*=\s*(\{[\s\S]*?\});/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        jsonObjects.push(parsed);
      } catch {
        // Ignore
      }
    }
  });

  return jsonObjects;
}

/**
 * Extracts all publicly exposed hyperlinks (<a href>) and resolves relative URLs against the base URL.
 * 
 * @param {cheerio.CheerioAPI} $
 * @param {string} baseUrl
 * @returns {Array<{ href: string, text: string, rel: string, class: string, id: string }>}
 */
export function extractHyperlinks($, baseUrl) {
  const links = [];
  const seenUrls = new Set();

  $('a[href]').each((_, el) => {
    const rawHref = $(el).attr('href');
    const resolved = resolveRelativeUrl(baseUrl, rawHref);
    if (!resolved) return;

    if (!seenUrls.has(resolved)) {
      seenUrls.add(resolved);
      links.push({
        href: resolved,
        rawHref: rawHref || '',
        text: $(el).text().trim(),
        rel: $(el).attr('rel') || '',
        class: $(el).attr('class') || '',
        id: $(el).attr('id') || '',
      });
    }
  });

  return links;
}

/**
 * Extracts publicly exposed form actions.
 * 
 * @param {cheerio.CheerioAPI} $
 * @param {string} baseUrl
 * @returns {Array<{ action: string, method: string }>}
 */
export function extractFormActions($, baseUrl) {
  const forms = [];
  $('form').each((_, el) => {
    const rawAction = $(el).attr('action') || '';
    const resolved = resolveRelativeUrl(baseUrl, rawAction);
    if (resolved) {
      forms.push({
        action: resolved,
        method: ($(el).attr('method') || 'GET').toUpperCase(),
      });
    }
  });
  return forms;
}

/**
 * High-level HTML parser result for intermediate and source pages.
 * 
 * @param {string} html
 * @param {string} url
 * @param {object} [options]
 * @returns {object}
 */
export function parseHtml(html, url, options = {}) {
  // 1. Check for verification challenges first
  const challengeCheck = detectHumanVerificationChallenge(html, url, options.provider);
  if (challengeCheck.isChallenge) {
    return {
      success: false,
      challenge: true,
      challengeResult: challengeCheck.result,
    };
  }

  const $ = cheerio.load(html || '');
  const title = $('title').text().trim();
  const canonicalUrl = extractCanonicalUrl($, url);
  const metaRefresh = extractMetaRefresh($, url);
  const links = extractHyperlinks($, url);
  const forms = extractFormActions($, url);
  const jsonObjects = extractJsonFromScripts($);

  return {
    success: true,
    challenge: false,
    title,
    canonicalUrl,
    metaRefresh,
    links,
    forms,
    jsonObjects,
    $,
  };
}
