import * as cheerio from 'cheerio';
import { normalizeSize } from '../utils/normalize.js';
import { extractMirrors } from '../parsing/mirror-parser.js';
import { logger } from '../logging/logger.js';
import { providerRegistry } from './provider-registry.js';

/**
 * Extracts the file ID from a GDFLIX-style provider URL.
 * Example: https://provider.example/file/9QWlfgZTmmiv837 -> 9QWlfgZTmmiv837
 * 
 * @param {string} url
 * @returns {string|null}
 */
export function extractGdflixFileId(url) {
  if (!url || typeof url !== 'string') return null;

  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/(?:file|pack|share|d|drive|video)\/([a-zA-Z0-9_\-]+)/i);
    if (match && match[1]) {
      return match[1];
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Parses a GDFLIX file-information page.
 * Extracts publicly displayed file details: name, format, size, addedDate, mirrors.
 * Does not assume the file ID is the downloadable file.
 * 
 * @param {string} html - HTML of provider page
 * @param {string} url - URL of provider page
 * @returns {object}
 */
export function parseGdflix(html, url) {
  const fileId = extractGdflixFileId(url);
  const $ = cheerio.load(html || '');

  // Extract filename
  let filename = $('#fileName').text().trim();
  if (!filename) {
    $('table.table-info tr, table tr').each((_, el) => {
      const th = $(el).find('th').text().trim().toLowerCase();
      if (th.includes('file name') || th.includes('name')) {
        filename = $(el).find('td').text().trim();
      }
    });
  }
  if (!filename) {
    filename = $('h2, h1').first().text().trim();
  }

  // Extract format
  let format = null;
  $('table.table-info tr, table tr').each((_, el) => {
    const th = $(el).find('th').text().trim().toLowerCase();
    if (th.includes('file format') || th.includes('format')) {
      format = $(el).find('td').text().trim().toLowerCase();
    }
  });
  if (!format && filename) {
    const extMatch = filename.match(/\.([a-zA-Z0-9]{2,5})$/);
    if (extMatch) format = extMatch[1].toLowerCase();
  }

  // Extract size
  let sizeDisplay = null;
  $('table.table-info tr, table tr').each((_, el) => {
    const th = $(el).find('th').text().trim().toLowerCase();
    if (th.includes('file size') || th.includes('size')) {
      sizeDisplay = $(el).find('td').text().trim();
    }
  });

  const { sizeBytes, sizeDisplay: normalizedDisplay } = normalizeSize(sizeDisplay);

  // Extract added date
  let addedDate = null;
  $('table.table-info tr, table tr').each((_, el) => {
    const th = $(el).find('th').text().trim().toLowerCase();
    if (th.includes('date added') || th.includes('date')) {
      addedDate = $(el).find('td').text().trim();
    }
  });

  // Extract mirrors
  const mirrors = extractMirrors($, url);

  logger.parsing(`GDFLIX page parsed: ID=${fileId}, Filename="${filename}", Size=${normalizedDisplay || 'N/A'}`);

  return {
    provider: 'GDFLIX',
    providerUrl: url,
    fileId,
    filename,
    format,
    sizeBytes,
    sizeDisplay: normalizedDisplay || sizeDisplay,
    addedDate,
    mirrors,
  };
}

// Register GDFLIX in provider registry
providerRegistry.register({
  name: 'GDFLIX',
  domains: ['gdflix.example', 'provider.example', 'gdflix.dev', 'gdflix.io', 'new4.gdflix.io', 'gdflix.top', 'dtflix.ink', 'dotflix.store'],
  matchUrl: (url) => (/(?:gdflix|dtflix|dotflix)/i.test(url) && /\/(?:file|pack|share|drive)\/[a-zA-Z0-9_\-]+/i.test(url)) || (!/hubcloud/i.test(url) && /\/(?:file|pack|share)\/[a-zA-Z0-9_\-]+/i.test(url)),
  parser: parseGdflix,
});

// Register HubCloud in provider registry
providerRegistry.register({
  name: 'HubCloud',
  domains: ['hubcloud.foo', 'hubcloud.dev', 'hubcloud.club', 'hubcloud.link'],
  matchUrl: (url) => /hubcloud/i.test(url),
  parser: parseGdflix,
});

export default {
  extractGdflixFileId,
  parseGdflix,
};
