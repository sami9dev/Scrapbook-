import * as cheerio from 'cheerio';
import { logger } from '../../logging/logger.js';

/**
 * Extracts UNiTYhub page metadata and TMDB ID from HTML or URL.
 * 
 * @param {string} html 
 * @param {string} [sourceUrl] 
 * @returns {{
 *   title: string,
 *   type: 'tv' | 'movie',
 *   tmdbId: string|null,
 *   slug: string|null
 * }}
 */
export function extractUnityHubMetadata(html, sourceUrl = '') {
  let type = 'tv';
  let tmdbId = null;
  let slug = null;

  // 1. Try URL parsing first
  if (sourceUrl) {
    const urlMatch = sourceUrl.match(/\/(tv|movie)\/(\d+)(?:-([a-zA-Z0-9_-]+))?/i);
    if (urlMatch) {
      type = urlMatch[1].toLowerCase();
      tmdbId = urlMatch[2];
      slug = urlMatch[3] || null;
    }
  }

  // 2. Try HTML inspection
  let pageTitle = 'Unknown Title';
  if (html && typeof html === 'string') {
    const $ = cheerio.load(html);

    // Check canonical link or og:url
    const canonical = $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content') || '';
    if (!tmdbId && canonical) {
      const match = canonical.match(/\/(tv|movie)\/(\d+)(?:-([a-zA-Z0-9_-]+))?/i);
      if (match) {
        type = match[1].toLowerCase();
        tmdbId = match[2];
        slug = match[3] || null;
      }
    }

    // Extract title
    const rawTitle = $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '';
    pageTitle = rawTitle.replace(/[—–-].*$/, '').trim() || 'UNiTYhub Release';
  }

  return {
    title: pageTitle,
    type,
    tmdbId,
    slug,
  };
}

/**
 * Normalizes a UNiTYhub link to its live functional URL.
 * E.g. https://hubcloud.foo/video/xyz -> https://hubcloud.ist/video/xyz
 * 
 * @param {string} link 
 * @returns {string}
 */
export function normalizeUnityHubLink(link) {
  if (!link || typeof link !== 'string') return '';
  let cleaned = link.trim();
  if (cleaned.includes('hubcloud.foo/video/')) {
    cleaned = cleaned.replace('hubcloud.foo/video/', 'hubcloud.ist/video/');
  }
  return cleaned;
}

/**
 * Fetches and parses download nodes directly from UNiTYhub API.
 * 
 * @param {string} tmdbId 
 * @param {'tv' | 'movie'} type 
 * @param {string} [sourceUrl] 
 * @returns {Promise<{
 *   title: string,
 *   type: 'tv' | 'movie',
 *   audios: string[],
 *   links: Array<object>
 * }>}
 */
export async function fetchUnityHubReleases(tmdbId, type = 'tv', sourceUrl = '') {
  if (!tmdbId) {
    throw new Error('tmdbId is required to fetch UNiTYhub releases');
  }

  const extensionKey = type === 'tv' ? `tv_${tmdbId}` : tmdbId;
  const apiUrl = `https://www.unityhub.buzz/api/fallback/movie_extensions/${extensionKey}`;
  
  logger.discovered(`[UNiTYhub] Querying API: ${apiUrl}`);

  const res = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Referer': sourceUrl || 'https://www.unityhub.buzz/',
    },
  });

  if (!res.ok) {
    throw new Error(`UNiTYhub API returned HTTP status ${res.status}`);
  }

  const json = await res.json();
  if (!json) {
    return { title: 'Unknown Title', type, audios: [], links: [] };
  }

  const pageTitle = json.name || json.title || 'UNiTYhub Release';
  const audios = Array.isArray(json.audios) ? json.audios : [];
  const rawNodes = Array.isArray(json.downloadNodes) ? json.downloadNodes : [];

  const links = rawNodes.map((node) => {
    const rawLink = node.link || '';
    const normalizedLink = normalizeUnityHubLink(rawLink);
    const scope = (node.releaseType === 'single' || node.episode) ? 'episode' : 'pack';
    const serverUpper = (node.server || 'UNKNOWN').toUpperCase();

    return {
      title: pageTitle,
      filename: node.filename || `${pageTitle} S${node.season || 1}${node.episode ? 'E' + node.episode : ' Pack'}`,
      scope,
      season: node.season !== undefined ? Number(node.season) : 1,
      episode: node.episode !== undefined && node.episode !== null ? Number(node.episode) : null,
      quality: node.quality || '1080p',
      codec: node.codec || null,
      sizeDisplay: node.size || null,
      provider: serverUpper,
      providerUrl: normalizedLink,
      sourceUrl: sourceUrl || `https://www.unityhub.buzz/${type}/${tmdbId}`,
      status: 'RESOLVED',
    };
  });

  return {
    title: pageTitle,
    type,
    audios,
    links,
  };
}

export default {
  extractUnityHubMetadata,
  normalizeUnityHubLink,
  fetchUnityHubReleases,
};
