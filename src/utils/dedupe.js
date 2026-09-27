import crypto from 'node:crypto';

/**
 * Generates a unique compound fingerprint for deduplicating scraped links.
 * Normalizes sourceUrl, providerUrl, and fileId.
 * 
 * @param {object} item
 * @param {string} item.sourceUrl
 * @param {string} [item.providerUrl]
 * @param {string} [item.fileId]
 * @returns {string}
 */
export function generateDedupeKey(item) {
  const normSource = (item.sourceUrl || '').trim().toLowerCase();
  const normMediator = (item.mediatorUrl || '').trim().toLowerCase();
  const normProvider = (item.providerUrl || '').trim().toLowerCase();
  const normFileId = (item.fileId || '').trim();

  // If mediator URL is known, it is the primary unique identifier across DISCOVERED and RESOLVED phases
  if (normMediator) {
    return `${normSource}::${normMediator}`;
  }

  // If both provider and fileId are known, compound with them
  if (normProvider && normFileId) {
    return `${normSource}::${normProvider}::${normFileId}`;
  }

  // If only provider URL is known
  if (normProvider) {
    return `${normSource}::${normProvider}`;
  }

  // Fallback to filename/title, season, episode, and quality
  const normTitle = (item.filename || item.title || '').trim().toLowerCase();
  const season = item.season ?? 'all';
  const episode = item.episode ?? 'all';
  const quality = item.quality ?? 'all';
  return `${normSource}::${normTitle}::S${season}E${episode}::Q${quality}`;
}

/**
 * Hashes a string using SHA-256 for compact indexing.
 */
export function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Filters out duplicate items from an array based on the deduplication key.
 * 
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export function deduplicateItems(items) {
  if (!Array.isArray(items)) return [];

  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = generateDedupeKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

export default {
  generateDedupeKey,
  hashKey,
  deduplicateItems,
};
