import { providerRegistry } from './provider-registry.js';
import { logger } from '../logging/logger.js';

/**
 * Extracts the file ID from a V-Cloud provider URL.
 * Example: https://vcloud.beer/yx8zfrldolv8lxq -> yx8zfrldolv8lxq
 * 
 * @param {string} url
 * @returns {string|null}
 */
export function extractVCloudFileId(url) {
  if (!url || typeof url !== 'string') return null;

  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || null;
  } catch {
    return null;
  }
}

/**
 * Parses a V-Cloud information / download page.
 * 
 * @param {string} html - HTML of provider page
 * @param {string} url - URL of provider page
 * @returns {object}
 */
export function parseVCloud(html, url) {
  const fileId = extractVCloudFileId(url);
  logger.parsing(`V-Cloud link recognized: ID=${fileId}, URL=${url}`);

  return {
    provider: 'V-Cloud',
    providerUrl: url,
    fileId,
    filename: null,
    format: null,
    sizeBytes: null,
    sizeDisplay: null,
    mirrors: [],
  };
}

// Register V-Cloud in provider registry
providerRegistry.register({
  name: 'V-Cloud',
  domains: ['vcloud.beer', 'vcloud.lol', 'vcloud.top', 'vcloud.one', 'vcloud.fit'],
  matchUrl: (url) => /vcloud\.[a-z]{2,}\/([a-zA-Z0-9_\-]+)/i.test(url),
  parser: parseVCloud,
});

export default {
  extractVCloudFileId,
  parseVCloud,
};
