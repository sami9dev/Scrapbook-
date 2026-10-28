import fs from 'fs';
import path from 'path';
import { logger } from '../logging/logger.js';
import { scrapedLinksRepo } from '../database/models.js';

const DATASET_PATH = path.resolve('src/data/tv-dataset.json');

/**
 * Detects platform name from URL or metadata.
 */
export function detectPlatformFromUrl(url) {
  if (!url) return 'Custom';
  const lower = url.toLowerCase();
  if (lower.includes('cloudmoviez')) return 'CloudMoviez';
  if (lower.includes('4khdhub') || lower.includes('hdhub4u') || lower.includes('4khub4u')) return '4KHDHub Archive';
  if (lower.includes('xdmovies') || lower.includes('xdmoviez')) return 'XDMovies';
  return 'Custom';
}

/**
 * Reads all catalog items from the JSON dataset.
 *
 * @returns {Array<object>}
 */
export function loadRawCatalog() {
  try {
    if (fs.existsSync(DATASET_PATH)) {
      return JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
    }
  } catch (err) {
    logger.error(`Error reading tv-dataset.json: ${err.message}`);
  }
  return [];
}

/**
 * Saves catalog items back to the JSON dataset.
 */
export function saveRawCatalog(items) {
  try {
    fs.writeFileSync(DATASET_PATH, JSON.stringify(items, null, 2), 'utf8');
    return true;
  } catch (err) {
    logger.error(`Error writing tv-dataset.json: ${err.message}`);
    return false;
  }
}

/**
 * Records or updates a title in the catalog store.
 * Prevents duplicates per platform/URL.
 *
 * @param {object} item
 * @param {string} item.title
 * @param {string} [item.url]
 * @param {string} [item.format]
 * @param {string} [item.genre]
 * @param {string} [item.country]
 * @param {string} [item.language]
 * @param {string} [item.platform]
 * @returns {boolean} true if newly added, false if already exists
 */
export function recordInCatalog(item) {
  if (!item || !item.title) return false;

  try {
    const items = loadRawCatalog();
    const cleanTitle = (item.title || '')
      .replace(/^Download\s+/i, '')
      .replace(/\{[^}]+\}/g, '')
      .replace(/\s*\(?(?:19|20)\d{2}\)?.*$/i, '')
      .trim();

    const platform = item.platform || detectPlatformFromUrl(item.url);
    const format = item.format || (item.isSeries ? 'Series' : 'Movie');

    const exists = items.some((i) => {
      const matchUrl = item.url && i.url && i.url === item.url;
      const matchTitlePlatform =
        i.platform === platform &&
        i.title.toLowerCase().trim() === (cleanTitle || item.title).toLowerCase().trim();
      return matchUrl || matchTitlePlatform;
    });

    if (!exists) {
      items.push({
        rank: items.length + 1,
        title: cleanTitle || item.title,
        url: item.url || null,
        format,
        genre: item.genre || 'Auto Discovered',
        country: item.country || 'Global',
        language: item.language || 'Multi',
        platform,
      });

      saveRawCatalog(items);
      logger.database(`[Store] Added "${cleanTitle || item.title}" (${platform}) to History & Dataset Container.`);
      return true;
    }
  } catch (err) {
    logger.warning(`Failed to record title in catalog: ${err.message}`);
  }
  return false;
}

/**
 * Returns the entire catalog enriched with live database link counts and scrape status.
 */
export async function getEnrichedCatalog() {
  const items = loadRawCatalog();
  let allLinks = [];

  try {
    allLinks = await scrapedLinksRepo.find({}, { limit: 10000 });
  } catch (err) {
    logger.warning(`Could not fetch scraped links for catalog enrichment: ${err.message}`);
  }

  return items.map((item) => {
    const itemTitle = (item.title || '').toLowerCase().trim();
    const itemUrl = (item.url || '').toLowerCase().trim();

    const matchingLinks = allLinks.filter((l) => {
      if (itemUrl && l.sourceUrl && l.sourceUrl.toLowerCase() === itemUrl) return true;
      const linkTitle = (l.title || l.filename || '').toLowerCase();
      return linkTitle.includes(itemTitle);
    });

    return {
      ...item,
      scrapedCount: matchingLinks.length,
      isScraped: matchingLinks.length > 0,
    };
  });
}

/**
 * Returns formatted links for a given title or URL.
 */
export async function getFormattedCatalogLinks(title, options = {}) {
  const normTitle = (title || '').toLowerCase().trim();
  const allLinks = await scrapedLinksRepo.find({}, { limit: 5000 });

  const matchingLinks = allLinks.filter((l) => {
    if (options.sourceUrl && l.sourceUrl === options.sourceUrl) return true;
    const t = (l.title || l.filename || '').toLowerCase();
    return t.includes(normTitle);
  });

  const validLinks = matchingLinks.filter((l) => {
    const url = l.providerUrl || '';
    if (!url) return false;
    if (url.includes('greenmotors') || url.includes('?id=')) return false;
    if (url.includes('thenaukriadda') || url.includes('naukriadda')) return false;
    if (/dtflix|dotflix/i.test(url)) return false;
    return true;
  });

  const formattedText = validLinks
    .map((l) => {
      const fn = l.filename || l.title || 'release.mkv';
      const prov = (l.provider || 'RESOLVED').toUpperCase();
      return `Name : ${fn} ${prov} = ${l.providerUrl}`;
    })
    .join('\n');

  return {
    title,
    count: validLinks.length,
    links: validLinks,
    formattedText,
  };
}

export default {
  detectPlatformFromUrl,
  loadRawCatalog,
  saveRawCatalog,
  recordInCatalog,
  getEnrichedCatalog,
  getFormattedCatalogLinks,
};
