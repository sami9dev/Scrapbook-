import * as cheerio from 'cheerio';
import { extractPageTitle, inferContextFromDOM, detectContentTypeFromUrl } from './parser.js';
import { HUBCLOUD_BUTTON_PATTERNS } from './selectors.js';

/**
 * Extracts HubCloud download buttons and their dynamic mediator URLs from 4KHDHub HTML.
 * Adheres strictly to Section 4 & 5 of the specification.
 * 
 * @param {string} html Raw page HTML from 4KHDHub
 * @param {string} [sourceUrl] The original content page URL
 * @returns {{
 *   title: string,
 *   sourceUrl: string,
 *   contentType: 'movie'|'series'|'unknown',
 *   links: Array<{
 *     title: string,
 *     filename: string,
 *     scope: 'movie'|'episode'|'pack'|'all',
 *     season: number|null,
 *     episode: number|null,
 *     quality: string,
 *     language: string|null,
 *     provider: string,
 *     mediatorUrl: string,
 *     sourceUrl: string
 *   }>
 * }}
 */
export function extract4KHDHubLinks(html, sourceUrl = '') {
  if (!html || typeof html !== 'string') {
    return { title: 'Unknown Title', sourceUrl, contentType: 'unknown', links: [] };
  }

  const $ = cheerio.load(html);
  const title = extractPageTitle($);
  const links = [];
  const seenUrls = new Set();

  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim();

    // Skip empty, anchors, or javascript links
    if (!href || href === '#' || href.startsWith('javascript:')) {
      return;
    }

    const text = $el.text().trim();
    const ariaLabel = ($el.attr('aria-label') || '').trim();
    const titleAttr = ($el.attr('title') || '').trim();
    const combinedText = `${text} ${ariaLabel} ${titleAttr}`.trim();

    // Check if this button or link matches HubCloud download pattern
    const isHubCloudButton = HUBCLOUD_BUTTON_PATTERNS.some((pattern) => pattern.test(combinedText));

    if (!isHubCloudButton) {
      return;
    }

    // Resolve relative URLs against sourceUrl if necessary
    let mediatorUrl = href;
    if (sourceUrl && !href.startsWith('http://') && !href.startsWith('https://')) {
      try {
        mediatorUrl = new URL(href, sourceUrl).href;
      } catch {
        mediatorUrl = href;
      }
    }

    // Avoid duplicate mediator entries
    if (seenUrls.has(mediatorUrl)) {
      return;
    }
    seenUrls.add(mediatorUrl);

    // Invert context from surrounding DOM with sourceUrl awareness
    const context = inferContextFromDOM($el, $, sourceUrl);

    links.push({
      title,
      filename: context.filename || title,
      scope: context.scope || 'all',
      season: context.season,
      episode: context.episode,
      quality: context.quality,
      language: context.language,
      provider: 'HubCloud',
      mediatorUrl,
      sourceUrl,
    });
  });

  const detectedType = detectContentTypeFromUrl(sourceUrl) || (links.some((l) => l.scope === 'episode' || l.scope === 'pack') ? 'series' : (links.some((l) => l.scope === 'movie') ? 'movie' : 'unknown'));

  return {
    title,
    sourceUrl,
    contentType: detectedType,
    links,
  };
}

export default {
  extract4KHDHubLinks,
};
