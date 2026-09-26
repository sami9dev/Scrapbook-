import { parseXDMoviesPage } from './parser.js';
import { logger } from '../../logging/logger.js';

/**
 * Extracts and deduplicates candidate links from an XDMovies HTML page.
 * 
 * @param {string} html Page HTML
 * @param {string} sourceUrl Source page URL
 * @param {object} [options]
 * @param {string} [options.targetQuality] Optional quality filter (e.g. '2160p', '1080p')
 * @param {'all' | 'episode' | 'pack'} [options.targetScope] Optional scope filter
 * @returns {{
 *   title: string,
 *   type: string,
 *   audios: string[],
 *   ottSource: string|null,
 *   links: Array<object>
 * }}
 */
export function extractXDMoviesLinks(html, sourceUrl = '', options = {}) {
  const parsed = parseXDMoviesPage(html, sourceUrl);
  let links = parsed.links;
  const allLinks = [...links];

  // Filter by quality if requested
  if (options.targetQuality && options.targetQuality !== 'all') {
    const normTarget = options.targetQuality.toLowerCase().replace(/p$/, '');
    const filtered = links.filter((l) => (
      l.quality && l.quality.toLowerCase().replace(/p$/, '') === normTarget
    ));
    if (filtered.length > 0) {
      links = filtered;
    }
  }

  // Filter by scope if requested
  if (options.targetScope && options.targetScope !== 'all') {
    const filtered = links.filter((l) => l.scope === options.targetScope);
    if (filtered.length > 0) {
      links = filtered;
    }
  }

  logger.parsing(`[XDMovies] Extracted ${links.length} download links for "${parsed.title}" (Scope: ${options.targetScope || 'all'}, Quality: ${options.targetQuality || 'all'})`);

  return {
    ...parsed,
    allLinks,
    links,
  };
}

export default { extractXDMoviesLinks };

