import * as cheerio from 'cheerio';
import { resolveRelativeUrl } from '../utils/url.js';

/**
 * Extracts mirror links publicly displayed on a provider file-information page.
 * Does NOT follow the mirrors automatically, only discovers and records exposed URLs.
 * 
 * @param {cheerio.CheerioAPI|string} htmlOrCheerio
 * @param {string} baseUrl
 * @returns {Array<{ name: string, url: string, type: string }>}
 */
export function extractMirrors(htmlOrCheerio, baseUrl) {
  const $ = typeof htmlOrCheerio === 'string' ? cheerio.load(htmlOrCheerio) : htmlOrCheerio;
  const mirrors = [];
  const seenUrls = new Set();

  // Search selectors commonly containing mirror links
  const candidates = $(
    '.mirrors-list a, .mirror-btn, .btn-mirror, [class*="mirror"] a, table.mirrors a, a[href*="mirror"], a[href*="drive"], a[href*="download"]'
  );

  candidates.each((idx, el) => {
    const rawHref = $(el).attr('href');
    if (!rawHref) return;

    const resolved = resolveRelativeUrl(baseUrl, rawHref);
    if (!resolved || seenUrls.has(resolved)) return;

    // Filter out self-links or javascript/hash links
    if (resolved === baseUrl || rawHref.startsWith('#')) return;

    seenUrls.add(resolved);
    const text = $(el).text().trim() || $(el).attr('title') || `Mirror ${idx + 1}`;

    // Determine type heuristic
    let mirrorType = 'unknown';
    const lower = `${text} ${resolved}`.toLowerCase();
    if (lower.includes('direct') || lower.includes('fast')) {
      mirrorType = 'direct';
    } else if (lower.includes('cloud') || lower.includes('drive')) {
      mirrorType = 'cloud';
    } else if (lower.includes('stream')) {
      mirrorType = 'streaming';
    }

    mirrors.push({
      name: text,
      url: resolved,
      type: mirrorType,
    });
  });

  return mirrors;
}

export default extractMirrors;
