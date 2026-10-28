import * as cheerio from 'cheerio';
import { resolveRelativeUrl, normalizeNexdriveUrl } from '../utils/url.js';
import { providerRegistry } from '../providers/provider-registry.js';
import { logger } from '../logging/logger.js';

/**
 * Normalizes quality string from text or title.
 */
export function extractQuality(text) {
  if (!text) return null;
  const match = text.match(/\b(2160p|4k|1080p|720p|480p|576p|uhd)\b/i);
  if (!match) return null;
  const val = match[1].toLowerCase();
  if (val === '4k' || val === 'uhd') return '2160p';
  return val;
}

/**
 * Extracts codec from text.
 */
export function extractCodec(text) {
  if (!text) return null;
  if (/\b(h\.?265|hevc|x265|10bit)\b/i.test(text)) return 'H.265';
  if (/\b(h\.?264|avc|x264)\b/i.test(text)) return 'H.264';
  if (/\b(av1)\b/i.test(text)) return 'AV1';
  return null;
}

/**
 * Extracts audio information into an array.
 */
export function extractAudio(text) {
  if (!text) return [];
  const audios = [];
  if (/\b(atmos)\b/i.test(text)) audios.push('Atmos');
  if (/\b(ddpa|ddp|dd\+|dolby\s*digital\s*plus)\b/i.test(text)) audios.push('DDPA');
  if (/\b(dts-hd|dts)\b/i.test(text)) audios.push('DTS');
  if (/\b(truehd)\b/i.test(text)) audios.push('TrueHD');
  if (/\b(5\.1|7\.1|2\.0)\b/i.test(text)) {
    const channelMatch = text.match(/\b(5\.1|7\.1|2\.0)\b/i);
    if (channelMatch && !audios.includes(channelMatch[1])) {
      audios.push(channelMatch[1]);
    }
  }
  return audios;
}

/**
 * Extracts year from text.
 */
export function extractYear(text) {
  if (!text) return null;
  const match = text.match(/\b(19\d{2}|20\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extracts season number from text.
 */
export function extractSeason(text) {
  if (!text) return null;
  const sanitized = text.replace(/\bds4k\b/gi, '').replace(/\b4k\b/gi, '');
  const match = sanitized.match(/(?:^|[^a-zA-Z0-9])(?:season\s*|s)(\d{1,2})(?:e\d{1,3}|[^\d]|$)/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extracts episode number from text.
 */
export function extractEpisode(text) {
  if (!text) return null;
  const match = text.match(/(?:^|[^a-zA-Z0-9]|s\d{1,2})(?:e|ep|episodes?)\s*[:\s-]*(\d{1,3})(?:[^\d]|$)/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extracts language from text.
 */
export function extractLanguages(text) {
  if (!text) return [];
  const langs = [];
  const patterns = [
    { regex: /\b(multi(?:-?audio)?)\b/i, label: 'MULTI' },
    { regex: /\b(dual(?:-?audio)?)\b/i, label: 'Dual-Audio' },
    { regex: /\b(english|eng)\b/i, label: 'English' },
    { regex: /\b(hindi|hin)\b/i, label: 'Hindi' },
    { regex: /\b(tamil|tam)\b/i, label: 'Tamil' },
    { regex: /\b(telugu|tel)\b/i, label: 'Telugu' },
    { regex: /\b(spanish|spa)\b/i, label: 'Spanish' },
    { regex: /\b(french|fre)\b/i, label: 'French' },
    { regex: /\b(german|ger)\b/i, label: 'German' },
    { regex: /\b(japanese|jap)\b/i, label: 'Japanese' },
  ];

  for (const p of patterns) {
    if (p.regex.test(text) && !langs.includes(p.label)) {
      langs.push(p.label);
    }
  }
  return langs;
}

/**
 * Extracts file size string from text.
 */
/**
 * Extracts file size string from text.
 */
export function extractSizeDisplay(text) {
  if (!text) return null;
  const match = text.match(/(?:^|[^\d.])(\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB|Bytes))\b/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Parses an authorized source page to extract high-level media metadata
 * and all discovered download/provider links resolved against page origin.
 * 
 * @param {string} html - Raw HTML of source page
 * @param {string} sourceUrl - URL of source page
 * @returns {object}
 */
export function parseSourcePage(html, sourceUrl) {
  const $ = cheerio.load(html || '');
  const parsedSourceUrl = new URL(sourceUrl);
  const sourceDomain = parsedSourceUrl.hostname;

  // Title extraction
  const rawTitle =
    $('meta[property="og:title"]').attr('content') ||
    $('h1.entry-title').text().trim() ||
    $('h1').first().text().trim() ||
    $('title').text().trim() ||
    '';

  const fullText = $.text();

  // Extract structured metadata
  const year = extractYear(rawTitle) || extractYear(fullText);
  const isMovieUrl = /\/movies?\//i.test(sourceUrl) || /-movie(?:-\d+)?\/?$/i.test(sourceUrl);
  const season = isMovieUrl ? null : (extractSeason(rawTitle) || extractSeason(fullText));
  const episode = isMovieUrl ? null : (extractEpisode(rawTitle) || extractEpisode(fullText));
  const isTv = !isMovieUrl && (season !== null || episode !== null || /\b(tv series|tv show|season|episodes)\b/i.test(rawTitle + ' ' + fullText));
  const type = isTv ? 'tv' : 'movie';
  const quality = extractQuality(rawTitle) || extractQuality(fullText) || null;
  const codec = extractCodec(rawTitle) || extractCodec(fullText) || null;
  const audio = extractAudio(rawTitle + ' ' + fullText);
  const languages = extractLanguages(rawTitle + ' ' + fullText);
  const sizeDisplay = extractSizeDisplay(rawTitle) || extractSizeDisplay(fullText) || null;

  // Clean title: remove year, season info, quality tags for neat display
  let cleanTitle = rawTitle
    .replace(/\b(19\d{2}|20\d{2})\b/g, '')
    .replace(/\b(?:s|season)\s*\d{1,2}\b/gi, '')
    .replace(/\b(?:e|ep|episode)\s*\d{1,3}\b/gi, '')
    .replace(/\b(complete|pack|2160p|4k|1080p|720p|480p|web-dl|bluray|hevc|h\.?265|x264|hdr|sdr)\b/gi, '')
    .replace(/[\[\]\(\)\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanTitle) {
    cleanTitle = rawTitle;
  }

  // Extract all download/provider links and resolve relative URLs against origin
  const discoveredLinks = [];
  const seenHrefs = new Set();

  $('a[href]').each((_, el) => {
    const rawHref = $(el).attr('href');
    let resolved = resolveRelativeUrl(sourceUrl, rawHref);
    if (!resolved) return;

    // Normalize any Nexdrive mirror domain to canonical https://nexdrive.beer/genxfm
    if (/nexdrive\.[a-z]{2,}\/genxfm/i.test(resolved)) {
      resolved = normalizeNexdriveUrl(resolved);
    }

    // Filter out standard non-download WordPress / administrative & taxonomy paths
    if (/(?:wp-login|wp-admin|\/feed|\/tag\/|category|uncategorized|\/genre\/|\/quality\/|\/year\/|\/author\/|privacy-policy|contact-us|dmca|how-to-download|terms)/i.test(resolved)) {
      return;
    }

    // Skip links inside navigation headers, footers, or menus
    if ($(el).closest('header, footer, nav, .menu, .navigation, .sidebar, #header, #footer, #menu').length > 0) {
      return;
    }

    if (seenHrefs.has(resolved)) return;
    seenHrefs.add(resolved);

    const linkText = $(el).text().trim();
    const className = $(el).attr('class') || '';
    const childBtnClass = $(el).find('button').attr('class') || '';
    const id = $(el).attr('id') || '';

    // Check if this link matches a known provider
    const matchedProvider = providerRegistry.findProvider(resolved);

    // Determine if it is a candidate download/intermediate link
    const isInsideDownloadContainer = $(el).closest(
      '.cmz-row-card, .cmz-accordion, .download-section, [class*="download"], [class*="accordion"]'
    ).length > 0;

    const isCandidate =
      matchedProvider !== null ||
      /vcloud/i.test(resolved) ||
      /nexdrive\.[a-z]{2,}\/genxfm/i.test(resolved) ||
      /(?:download|btn|button|drive|file|intermediate|redirect|cmz-btn|vcloud|nexdrive|genxfm)/i.test(`${linkText} ${className} ${childBtnClass} ${id} ${rawHref}`) ||
      // Single-letter button text e.g. "G" from section 3
      /^[a-zA-Z]$/.test(linkText) ||
      (isInsideDownloadContainer && !resolved.endsWith('/') && !resolved.includes('#'));

    if (isCandidate) {
      // Contextual extraction from surrounding container/row/card
      const container = $(el).closest(
        '.cmz-row-card, .cmz-accordion, [class*="accordion"], [class*="card"], [class*="row"], [class*="filter-item"], tr, li, p, section'
      );
      const containerText = container.text().replace(/\s+/g, ' ').trim();

      // Check for row title or release filename in the closest card or container
      const rowTitleEl = container.find('.cmz-row-title, [class*="row-title"], [class*="file-title"], [class*="release-title"]').first();
      const rowTitle = rowTitleEl.length > 0 ? rowTitleEl.text().trim() : null;

      const rowQuality = extractQuality(rowTitle);
      const rowCodec = extractCodec(rowTitle);
      const rowSeason = extractSeason(rowTitle);
      const rowEpisode = extractEpisode(rowTitle);

      // Preceding header text (e.g. <h5>... 480p x264 [150MB/E]</h5> or <h4>-:Episodes: 1:-</h4>)
      let prevHeaderText = null;
      if (container.length > 0) {
        let prevHeader = container.prevAll('h1, h2, h3, h4, h5, h6').first();
        if (prevHeader.length === 0 && container.parent().length > 0) {
          prevHeader = container.parent().prevAll('h1, h2, h3, h4, h5, h6').first();
        }
        if (prevHeader.length > 0) {
          prevHeaderText = prevHeader.text().replace(/\s+/g, ' ').trim();
        }
      }

      const linkQuality = rowQuality || extractQuality(containerText) || extractQuality(linkText) || (prevHeaderText ? extractQuality(prevHeaderText) : null) || null;
      const linkCodec = rowCodec || extractCodec(containerText) || extractCodec(linkText) || (prevHeaderText ? extractCodec(prevHeaderText) : null) || null;
      const linkSize = extractSizeDisplay(linkText) || (prevHeaderText ? extractSizeDisplay(prevHeaderText) : null) || extractSizeDisplay(containerText) || null;
      const linkSeason = rowSeason ?? extractSeason(containerText) ?? (prevHeaderText ? extractSeason(prevHeaderText) : null) ?? season;
      let linkEpisode = rowEpisode ?? extractEpisode(containerText) ?? (prevHeaderText ? extractEpisode(prevHeaderText) : null) ?? null;

      const isBatch = /(?:batch|zip)/i.test(`${linkText} ${rawHref} ${resolved}`);
      let linkScope = 'episode';
      if (isBatch) {
        linkScope = 'pack';
      } else if (linkEpisode !== null && linkEpisode !== undefined) {
        linkScope = 'episode';
      } else if (isMovieUrl || type === 'movie') {
        linkScope = 'movie';
      } else {
        linkScope = 'episode';
      }

      let provName = matchedProvider ? matchedProvider.name : null;
      if (!provName) {
        if (/vcloud/i.test(resolved) || /v-?cloud/i.test(linkText)) {
          provName = 'V-Cloud';
        } else if (/nexdrive\.[a-z]{2,}\/genxfm/i.test(resolved)) {
          provName = 'Nexdrive';
        }
      }

      discoveredLinks.push({
        resolvedUrl: resolved,
        rawHref,
        buttonText: linkText,
        rowTitle: rowTitle || null,
        filename: rowTitle || null,
        sectionTitle: prevHeaderText || null,
        provider: provName,
        isIntermediate: provName === null || provName === 'Nexdrive',
        quality: linkQuality,
        codec: linkCodec,
        sizeDisplay: linkSize,
        season: linkSeason,
        episode: linkEpisode,
        scope: linkScope,
      });
    }
  });

  // Prioritize V-Cloud links when multiple mirrors exist for an item/episode/quality tier
  const hasVCloudLinks = discoveredLinks.some(
    (l) => /vcloud/i.test(l.resolvedUrl) || l.provider === 'V-Cloud' || /v-?cloud/i.test(l.buttonText || '')
  );
  let finalDiscoveredLinks = discoveredLinks;
  if (hasVCloudLinks) {
    const isVCloudLink = (l) =>
      /vcloud/i.test(l.resolvedUrl) || l.provider === 'V-Cloud' || /v-?cloud/i.test(l.buttonText || '');

    const groupMap = new Map();
    for (const link of discoveredLinks) {
      const sectionKey = link.rowTitle || link.sectionTitle || `${link.quality || 'unknown'}_${link.season ?? 'all'}`;
      const groupKey = `${sectionKey}_${link.episode ?? 'all'}_${link.scope || 'episode'}`;
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, []);
      }
      groupMap.get(groupKey).push(link);
    }

    finalDiscoveredLinks = [];
    for (const [, links] of groupMap.entries()) {
      const vcloudLinks = links.filter(isVCloudLink);
      if (vcloudLinks.length > 0) {
        finalDiscoveredLinks.push(...vcloudLinks);
      } else {
        finalDiscoveredLinks.push(...links);
      }
    }
  }

  logger.parsing(`Parsed source page: "${cleanTitle}" (${year || 'unknown year'}), ${finalDiscoveredLinks.length} candidate links found`);

  return {
    sourceUrl,
    sourceDomain,
    title: cleanTitle,
    rawTitle,
    year,
    type,
    season,
    episode,
    quality,
    codec,
    audio,
    languages,
    sizeDisplay,
    discoveredLinks: finalDiscoveredLinks,
  };
}

export default parseSourcePage;
