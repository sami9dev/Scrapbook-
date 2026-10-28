import { extractUnityHubMetadata, fetchUnityHubReleases } from './parser.js';
import { matchesQuality } from '../../utils/normalize.js';
import { logger } from '../../logging/logger.js';

/**
 * Extracts candidate download links from UNiTYhub.
 * 
 * @param {string} html Raw page HTML (or empty string if URL provided)
 * @param {string} sourceUrl Source page URL
 * @param {object} [options]
 * @param {string} [options.targetQuality] Optional quality filter (e.g. '1080p')
 * @param {'all' | 'episode' | 'pack'} [options.targetScope] Optional scope filter
 * @param {string} [options.targetProvider] Optional provider filter ('HUBCLOUD', 'GDFLIX')
 * @returns {Promise<{
 *   title: string,
 *   type: string,
 *   audios: string[],
 *   allLinks: Array<object>,
 *   links: Array<object>
 * }>}
 */
export async function extractUnityHubLinks(html, sourceUrl = '', options = {}) {
  const meta = extractUnityHubMetadata(html, sourceUrl);
  if (!meta.tmdbId) {
    throw new Error('Unable to extract TMDB ID from UNiTYhub HTML or URL.');
  }

  const fetched = await fetchUnityHubReleases(meta.tmdbId, meta.type, sourceUrl);
  let links = fetched.links;
  const allLinks = [...links];

  // Filter by quality
  if (options.targetQuality && options.targetQuality !== 'all') {
    const filtered = links.filter((l) => matchesQuality(l.quality, options.targetQuality));
    if (filtered.length > 0) links = filtered;
  }

  // Filter by scope
  if (options.targetScope && options.targetScope !== 'all') {
    const filtered = links.filter((l) => l.scope === options.targetScope);
    if (filtered.length > 0) links = filtered;
  }

  // Filter by provider
  if (options.targetProvider && options.targetProvider !== 'all') {
    const targetProvUpper = options.targetProvider.toUpperCase();
    const filtered = links.filter((l) => l.provider && l.provider.toUpperCase().includes(targetProvUpper));
    if (filtered.length > 0) links = filtered;
  }

  logger.parsing(`[UNiTYhub] Extracted ${links.length} download links for "${fetched.title}" (Scope: ${options.targetScope || 'all'}, Quality: ${options.targetQuality || 'all'})`);

  return {
    ...fetched,
    allLinks,
    links,
  };
}

export default { extractUnityHubLinks };
