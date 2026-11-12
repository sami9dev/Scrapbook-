import * as cheerio from 'cheerio';
import { logger } from '../../logging/logger.js';

/**
 * Searches XDMovies for a movie or TV series title.
 *
 * @param {string} query Search terms (e.g. "Campus Drivers", "Squid Game")
 * @param {object} [options]
 * @param {string} [options.baseUrl='https://huh.xdmovies.wtf']
 * @returns {Promise<{
 *   success: boolean,
 *   query: string,
 *   results: Array<{ title: string, url: string, isMovie: boolean, isSeries: boolean, provider: string }>,
 *   bestMatch: { title: string, url: string, isMovie: boolean, isSeries: boolean, provider: string }|null,
 *   error?: string
 * }>}
 */
export async function searchXDMovies(query, options = {}) {
  const trimmed = (query || '').trim();
  if (!trimmed) {
    return { success: false, query: '', results: [], bestMatch: null, error: 'Empty search query' };
  }

  const baseUrl = (options.baseUrl || 'https://huh.xdmovies.wtf').replace(/\/+$/, '');
  const searchUrl = `${baseUrl}/?s=${encodeURIComponent(trimmed)}`;

  logger.discovered(`Searching XDMovies for title "${trimmed}" via ${searchUrl}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('XDMovies search timeout')), options.timeoutMs || 8000);
    timeout.unref?.();

    let res;
    try {
      res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      return { success: false, query: trimmed, results: [], bestMatch: null, error: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (html.includes('Just a moment...') || html.includes('cf-turnstile')) {
      logger.warning(`XDMovies search hit Cloudflare challenge for "${trimmed}"`);
      return { success: false, query: trimmed, results: [], bestMatch: null, error: 'Cloudflare challenge' };
    }

    const $ = cheerio.load(html);
    const results = [];
    const seenUrls = new Set();

    $('a[href*="/movies/"], a[href*="/series/"]').each((_, el) => {
      const card = $(el);
      let href = card.attr('href') || '';
      if (!href || /\/category\/|\/tag\/|\/page\//i.test(href)) return;

      const fullUrl = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);

      const title = card.find('.title, h2, h3, .movie-title, .name').text().trim() ||
                    card.text().trim().split('\n').filter(Boolean)[0] || '';
      const cleanTitle = title.replace(/\s+/g, ' ').trim();
      const isMovie = href.includes('/movies/');
      const isSeries = href.includes('/series/');

      if (cleanTitle && fullUrl) {
        results.push({
          title: cleanTitle,
          url: fullUrl,
          isMovie,
          isSeries,
          provider: 'XDMovies',
        });
      }
    });

    // Find best match matching the query words
    const queryLower = trimmed.toLowerCase();
    const queryTokens = queryLower.split(/\s+/).filter(Boolean);

    let bestMatch = null;
    let highestScore = -1;

    for (const item of results) {
      const itemTitleLower = item.title.toLowerCase();
      let score = 0;
      if (itemTitleLower === queryLower) {
        score = 100;
      } else if (itemTitleLower.startsWith(queryLower)) {
        score = 80;
      } else {
        const matches = queryTokens.filter((t) => itemTitleLower.includes(t)).length;
        score = (matches / queryTokens.length) * 60;
      }

      if (score > highestScore && score >= 30) {
        highestScore = score;
        bestMatch = item;
      }
    }

    if (!bestMatch && results.length > 0) {
      bestMatch = results[0];
    }

    logger.discovered(`XDMovies search "${trimmed}" found ${results.length} result(s), best: "${bestMatch?.title || 'none'}"`);

    return {
      success: results.length > 0,
      query: trimmed,
      results,
      bestMatch,
    };
  } catch (err) {
    logger.error(`Error searching XDMovies for "${trimmed}": ${err.message}`);
    return { success: false, query: trimmed, results: [], bestMatch: null, error: err.message };
  }
}

export default { searchXDMovies };
