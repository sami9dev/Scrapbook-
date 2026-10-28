import { fetchWithControls } from '../../discovery/http-client.js';
import { logger } from '../../logging/logger.js';
import * as cheerio from 'cheerio';

/**
 * Searches 4KHDHub for a movie or TV series title.
 * Returns ranked matching posts with titles, URLs, and inferred content types.
 *
 * @param {string} query Search terms (e.g., "Inception", "Breaking Bad")
 * @param {object} [options]
 * @param {string} [options.baseUrl='https://4khdhub.one']
 * @returns {Promise<{
 *   success: boolean,
 *   query: string,
 *   results: Array<{ title: string, url: string, isMovie: boolean, isSeries: boolean }>,
 *   bestMatch: { title: string, url: string, isMovie: boolean, isSeries: boolean }|null,
 *   error?: string
 * }>}
 */
export async function search4KHDHub(query, options = {}) {
  const trimmed = (query || '').trim();
  if (!trimmed) {
    return { success: false, query: '', results: [], bestMatch: null, error: 'Empty search query' };
  }

  const baseUrl = (options.baseUrl || 'https://4khdhub.one').replace(/\/+$/, '');
  const searchUrl = `${baseUrl}/?s=${encodeURIComponent(trimmed)}`;

  logger.discovered(`Searching 4KHDHub for title "${trimmed}" via ${searchUrl}`);

  try {
    const res = await fetchWithControls(searchUrl, {
      timeoutMs: options.timeoutMs || 10000,
      maxRetries: 2,
    });

    if (!res.success || !res.body) {
      logger.warning(`Failed to fetch 4KHDHub search page for "${trimmed}": ${res.error || 'Empty response'}`);
      return {
        success: false,
        query: trimmed,
        results: [],
        bestMatch: null,
        error: res.error || 'Failed to fetch search results',
      };
    }

    const $ = cheerio.load(res.body);
    const results = [];
    const seenUrls = new Set();

    $('article, .movie-card, .post-item, .thumb, a').each((_, el) => {
      let href = $(el).attr('href') || '';
      if (!href && $(el).is('article, .movie-card, .thumb')) {
        href = $(el).find('a').first().attr('href') || '';
      }
      if (!href || /\/category\/|\/tag\/|\/page\/|\/author\//i.test(href)) return;

      // Extract title from headers, card titles, or title attributes
      const titleText =
        $(el).find('.title, h2, h3, .entry-title').text().trim() ||
        $(el).attr('title') ||
        $(el).find('img').attr('alt') ||
        $(el).text().trim();

      // Only match valid post URLs (movies or series ending in ID)
      const isMovie = /-movie(?:-\d+)?\/?$/i.test(href);
      const isSeries = /-series(?:-\d+)?\/?$/i.test(href);
      const isValidPost = isMovie || isSeries || /4khdhub\.[a-z0-9.]+\/[a-z0-9-]+-\d+\/?$/i.test(href);

      if (isValidPost) {
        const fullUrl = href.startsWith('http') ? href : new URL(href, res.finalUrl || baseUrl).href;
        if (!seenUrls.has(fullUrl)) {
          seenUrls.add(fullUrl);
          const cleanTitle = titleText.replace(/\s+/g, ' ').slice(0, 150).trim();
          results.push({
            title: cleanTitle || trimmed,
            url: fullUrl,
            isMovie,
            isSeries,
          });
        }
      }
    });

    if (results.length === 0) {
      logger.discovered(`No results found on 4KHDHub for "${trimmed}"`);
      return { success: true, query: trimmed, results: [], bestMatch: null };
    }

    // Rank results by relevance to the query
    const lowerQuery = trimmed.toLowerCase();
    results.sort((a, b) => {
      const aLower = a.title.toLowerCase();
      const bLower = b.title.toLowerCase();

      // 1. Exact match
      const aExact = aLower === lowerQuery;
      const bExact = bLower === lowerQuery;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      // 2. Starts with query
      const aStarts = aLower.startsWith(lowerQuery);
      const bStarts = bLower.startsWith(lowerQuery);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;

      // 3. Contains query
      const aContains = aLower.includes(lowerQuery);
      const bContains = bLower.includes(lowerQuery);
      if (aContains && !bContains) return -1;
      if (!aContains && bContains) return 1;

      // 4. Shorter title closer to query length
      return a.title.length - b.title.length;
    });

    const bestMatch = results[0] || null;
    logger.discovered(`Search for "${trimmed}" resolved best match: "${bestMatch?.title}" -> ${bestMatch?.url}`);

    return {
      success: true,
      query: trimmed,
      results,
      bestMatch,
    };
  } catch (err) {
    logger.error(`Error during 4KHDHub search for "${trimmed}": ${err.message}`);
    return {
      success: false,
      query: trimmed,
      results: [],
      bestMatch: null,
      error: err.message,
    };
  }
}

export default {
  search4KHDHub,
};
