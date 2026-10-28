/**
 * 4KHub4U Catalogue Parser
 *
 * Extracts complete, non-lossy release catalogue from 4KHub4U / 4KHDHub HTML.
 * Strictly adheres to Sections 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 27, and 28.
 *
 * Performance guarantee:
 * - Operates purely on static HTML via Cheerio.
 * - Zero browser launch.
 * - Sub-10ms parsing execution.
 */

import * as cheerio from 'cheerio';
import { extractPageTitle, detectContentTypeFromUrl } from '../../providers/4khdhub/parser.js';
import { isHubCloudDriveUrl } from '../../providers/hubcloud/validator.js';
import { fetchWithControls } from '../../discovery/http-client.js';
import { extractEmbeddedMediatorPayload } from '../../resolvers/mediator/http-first.js';
import { INVALID_LINK_PATTERNS } from '../../resolvers/mediator/detector.js';
import { logger } from '../../logging/logger.js';

// ─── Regex & Pattern Definitions ─────────────────────────────────────────────

const RESOLUTION_PATTERNS = [
  { normalized: '2160p', regex: /\b(2160p|4k|uhd)\b/i },
  { normalized: '1080p', regex: /\b(1080p|fhd)\b/i },
  { normalized: '720p', regex: /\b(720p|hd)\b/i },
  { normalized: '480p', regex: /\b(480p|sd)\b/i },
];

const DYNAMIC_RANGE_PATTERNS = [
  { label: 'Dolby Vision + HDR', regex: /\b(?:dovi[\s_-]*hdr|dv[\s_-]*hdr|hdr[\s_-]*dv|hdr[\s_-]*dovi)\b/i },
  { label: 'Dolby Vision', regex: /\b(?:dolby\s*vision|dovi|dv)\b/i },
  { label: 'HDR10+', regex: /\bhdr10\+\b/i },
  { label: 'HDR10', regex: /\bhdr10\b/i },
  { label: 'HDR', regex: /\bhdr\b/i },
  { label: 'SDR', regex: /\bsdr\b/i },
];

const CODEC_PATTERNS = [
  { label: 'HEVC', regex: /\b(hevc|x265|h\.?265)\b/i },
  { label: 'x264', regex: /\b(x264|h\.?264|avc)\b/i },
  { label: 'VP9', regex: /\bvp9\b/i },
  { label: 'AV1', regex: /\bav1\b/i },
];

const BIT_DEPTH_PATTERNS = [
  { label: '10-bit', regex: /\b(10[\s-]?bit|10bit)\b/i },
  { label: '8-bit', regex: /\b(8[\s-]?bit|8bit)\b/i },
];

const SOURCE_TYPE_PATTERNS = [
  { label: 'REMUX', regex: /\bremux\b/i },
  { label: 'BluRay', regex: /\b(bluray|bdrip|brrip)\b/i },
  { label: 'WEB-DL', regex: /\bweb[\s-]?dl\b/i },
  { label: 'WEBRip', regex: /\bwebrip\b/i },
  { label: 'HDTV', regex: /\bhdtv\b/i },
];

const AUDIO_PATTERNS = [
  'Hindi',
  'English',
  'Tamil',
  'Telugu',
  'Malayalam',
  'Kannada',
  'Bengali',
  'Marathi',
  'Punjabi',
  'Gujarati',
  'Urdu',
  'Japanese',
  'Korean',
  'Chinese',
  'Spanish',
  'French',
  'German',
  'Italian',
  'Russian',
  'Portuguese',
];

const FILE_SIZE_REGEX = /\b(\d+(?:\.\d+)?\s*(?:GB|MB))\b/i;
const SEASON_REGEX = /\bS(?:eason\s*)?(\d{1,2})\b/i;
const EPISODE_REGEX = /\b(?:S\d{1,2}\s*)?E(?:pisode\s*)?(\d{1,2})\b/i;

// ─── Attribute Extractors ───────────────────────────────────────────────────

/**
 * Extracts all independent video attributes from text according to Section 8.
 * Does NOT assume 2160p => HDR or HEVC => HDR.
 */
export function extractVideoAttributes(text = '') {
  let resolution;
  let originalResolution;
  for (const { normalized, regex } of RESOLUTION_PATTERNS) {
    const m = text.match(regex);
    if (m) {
      resolution = normalized;
      originalResolution = m[0];
      break;
    }
  }

  // Sense dynamic range with DV and HDR combinations (including dot-separated like DV.HDR)
  const hasDV = /\b(?:dolby[\s_.-]*vision|dovi|dv)\b/i.test(text);
  const hasHDR = /\b(?:hdr10\+|hdr10|hdr)\b/i.test(text);
  const hasHDR10Plus = /\bhdr10\+\b/i.test(text);
  const hasHDR10 = /\bhdr10\b/i.test(text);
  const hasExplicitSDR = /\bsdr\b/i.test(text);

  let dynamicRange;
  if (hasDV && hasHDR) {
    dynamicRange = 'Dolby Vision + HDR';
  } else if (hasDV) {
    dynamicRange = 'Dolby Vision';
  } else if (hasHDR10Plus) {
    dynamicRange = 'HDR10+';
  } else if (hasHDR10) {
    dynamicRange = 'HDR10';
  } else if (hasHDR) {
    dynamicRange = 'HDR';
  } else if (hasExplicitSDR) {
    dynamicRange = 'SDR';
  }

  let codec;
  for (const { label, regex } of CODEC_PATTERNS) {
    if (regex.test(text)) {
      codec = label;
      break;
    }
  }

  let bitDepth;
  for (const { label, regex } of BIT_DEPTH_PATTERNS) {
    if (regex.test(text)) {
      bitDepth = label;
      break;
    }
  }

  let sourceType;
  for (const { label, regex } of SOURCE_TYPE_PATTERNS) {
    if (regex.test(text)) {
      sourceType = label;
      break;
    }
  }

  // Sense SDR: if we have video indicators (resolution, codec, or sourceType)
  // and no HDR/DV dynamic range was detected, it is SDR (Standard Dynamic Range / simple H.265 / x264)
  if (!dynamicRange && (resolution || codec || sourceType)) {
    dynamicRange = 'SDR';
  }

  const tags = [];
  if (sourceType) tags.push(sourceType);
  if (dynamicRange) tags.push(dynamicRange);
  if (codec) tags.push(codec);
  if (bitDepth) tags.push(bitDepth);

  return {
    resolution: resolution || undefined,
    originalResolution: originalResolution || resolution || undefined,
    dynamicRange: dynamicRange || undefined,
    codec: codec || undefined,
    bitDepth: bitDepth || undefined,
    sourceType: sourceType || undefined,
    tags,
  };
}

/**
 * Extracts all mentioned audio languages from text according to Section 9.
 */
export function extractAudioLanguages(text = '') {
  const languages = [];
  for (const lang of AUDIO_PATTERNS) {
    const rx = new RegExp(`\\b${lang}\\b`, 'i');
    if (rx.test(text)) {
      languages.push(lang);
    }
  }
  return languages;
}

/**
 * Formats a comprehensive release label preserving all variant attributes.
 * Examples: "2160p HDR 10-bit HEVC", "1080p x264", "2160p SDR"
 */
export function buildReleaseLabel(attrs, fallback = '') {
  const parts = [];
  if (attrs.resolution) parts.push(attrs.resolution);
  if (attrs.dynamicRange) parts.push(attrs.dynamicRange);
  if (attrs.bitDepth) parts.push(attrs.bitDepth);
  if (attrs.sourceType && !parts.includes(attrs.sourceType)) parts.push(attrs.sourceType);
  if (attrs.codec && !parts.includes(attrs.codec)) parts.push(attrs.codec);

  if (parts.length > 0) {
    return parts.join(' ');
  }
  return fallback.trim() || 'Standard Release';
}

// ─── Main Catalogue Parser ───────────────────────────────────────────────────

/**
 * Parses a 4KHub4U / 4KHDHub page HTML into a structured, complete release catalogue.
 *
 * @param {string} html Raw page HTML
 * @param {string} sourceUrl Content page URL
 * @returns {import('./types.js').FourKHubCatalogue} Complete structured catalogue
 */
export function parse4KHubCatalogue(html, sourceUrl = '') {
  if (!html || typeof html !== 'string') {
    throw new Error('Invalid HTML input provided to parse4KHubCatalogue');
  }

  const $ = cheerio.load(html);
  const rawTitle = extractPageTitle($);
  const yearMatch = (rawTitle + ' ' + $('title').text()).match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : undefined;

  // Clean title by removing year and domain suffixes
  const cleanTitle = rawTitle
    .replace(/\s*\(\s*(?:19\d{2}|20\d{2})\s*\)/g, '')
    .replace(/\s*[-–|]\s*(?:4KHDHub|4khub4u|Download).*$/i, '')
    .trim() || rawTitle;

  logger.log('4KHub4U', `[4KHub4U] page fetched: ${sourceUrl || 'direct HTML'}`);
  logger.log('4KHub4U', `[4KHub4U] source detected for "${cleanTitle}"`);

  // Detect series vs movie
  const urlType = detectContentTypeFromUrl(sourceUrl);
  const hasSeriesDOM =
    $('.season-item, .episode-item, .episode-header, [id*="season"], #complete-pack').length > 0 ||
    /download\s*complete\s*season/i.test(html) ||
    /download\s*individual\s*episodes/i.test(html) ||
    /\bS0?[1-9]\b/i.test(html);

  const contentType = urlType === 'movie' ? 'movie' : (hasSeriesDOM || urlType === 'series' ? 'series' : 'movie');

  const allReleases = [];
  const globalAudiosSet = new Set();
  const seenLinkUrls = new Set();

  // Helper to normalize and add download links
  const extractButtonsFromContainer = ($container) => {
    const links = [];
    $container.find('a[href]').each((_, aEl) => {
      const $a = $(aEl);
      let href = ($a.attr('href') || '').trim();
      if (!href || href === '#' || href.startsWith('javascript:')) return;

      // Normalize relative URLs
      if (sourceUrl && !href.startsWith('http://') && !href.startsWith('https://')) {
        try {
          href = new URL(href, sourceUrl).href;
        } catch {
          // keep original
        }
      }

      const text = $a.text().trim();
      const isHub = /hubcloud|hubdrive|drive|download/i.test(text) || /greenmotors|fast-share|fastdl|mediator|\?id=/i.test(href);
      if (!isHub) return;

      const provider = /hubdrive/i.test(text) ? 'HubDrive' : 'HubCloud';
      const isDirect = isHubCloudDriveUrl(href);

      links.push({
        provider,
        label: text || `Download ${provider}`,
        url: href,
        isDirectDestination: isDirect,
      });
    });
    return links;
  };

  // ─── 1. Series Extraction (Accordion / Season / Episode Items) ─────────────
  if (contentType === 'series') {
    // 1A. Check Complete Season Packs (.download-item inside season/pack sections)
    $('.download-item').each((_, itemEl) => {
      const $item = $(itemEl);
      const headerText = $item.find('.download-header').text().trim().replace(/\s+/g, ' ');
      const fileTitle = $item.find('.file-title').text().trim() || headerText;
      const combinedText = `${headerText} ${fileTitle}`;

      // Extract Season
      const sMatch = combinedText.match(SEASON_REGEX);
      const seasonNum = sMatch ? parseInt(sMatch[1], 10) : null;

      // Extract video attributes & audio
      const attrs = extractVideoAttributes(combinedText);
      const audios = extractAudioLanguages(combinedText);
      audios.forEach((a) => globalAudiosSet.add(a));

      const sizeMatch = combinedText.match(FILE_SIZE_REGEX);
      const fileSize = sizeMatch ? sizeMatch[1] : undefined;

      const downloadLinks = extractButtonsFromContainer($item);
      if (downloadLinks.length === 0) return;

      const label = buildReleaseLabel(attrs, headerText);

      allReleases.push({
        label,
        quality: {
          normalized: attrs.resolution || 'unknown',
          original: attrs.originalResolution || attrs.resolution || 'unknown',
        },
        resolution: attrs.resolution,
        codec: attrs.codec,
        dynamicRange: attrs.dynamicRange,
        bitDepth: attrs.bitDepth,
        sourceType: attrs.sourceType,
        tags: attrs.tags,
        audioLanguages: audios,
        fileSize,
        filename: fileTitle || undefined,
        scope: 'pack',
        season: seasonNum,
        episode: null,
        downloadLinks,
      });
    });

    // 1B. Check Accordion / Episode Groups (.season-item, .episode-item)
    $('.season-item, .episode-item').each((_, itemEl) => {
      const $item = $(itemEl);
      const epHeader = $item.find('.episode-header');
      const epNumberText = epHeader.find('.episode-number').text().trim();
      const epTitle = epHeader.find('.episode-title').text().trim();
      const epMeta = epHeader.find('.episode-meta').text().trim();
      const groupCombined = `${epNumberText} ${epTitle} ${epMeta}`;

      const sMatch = groupCombined.match(SEASON_REGEX);
      const groupSeason = sMatch ? parseInt(sMatch[1], 10) : null;
      const groupAttrs = extractVideoAttributes(groupCombined);
      const groupAudios = extractAudioLanguages(groupCombined);
      groupAudios.forEach((a) => globalAudiosSet.add(a));

      // Each individual episode download inside the group
      $item.find('.episode-download-item').each((_, epItemEl) => {
        const $epItem = $(epItemEl);
        const epFileTitle = $epItem.find('.episode-file-title').text().trim();
        const epFileInfo = $epItem.find('.episode-file-info').text().trim();
        const epCombined = `${epFileTitle} ${epFileInfo} ${groupCombined}`;

        const itemAttrs = extractVideoAttributes(epCombined);
        let dynamicRange = itemAttrs.dynamicRange;
        if (groupAttrs.dynamicRange && groupAttrs.dynamicRange !== 'SDR') {
          dynamicRange = groupAttrs.dynamicRange;
        } else if (itemAttrs.dynamicRange && itemAttrs.dynamicRange !== 'SDR') {
          dynamicRange = itemAttrs.dynamicRange;
        } else {
          dynamicRange = itemAttrs.dynamicRange || groupAttrs.dynamicRange || 'SDR';
        }

        const mergedAttrs = {
          resolution: itemAttrs.resolution || groupAttrs.resolution,
          originalResolution: itemAttrs.originalResolution || groupAttrs.originalResolution,
          dynamicRange,
          codec: itemAttrs.codec || groupAttrs.codec,
          bitDepth: itemAttrs.bitDepth || groupAttrs.bitDepth,
          sourceType: itemAttrs.sourceType || groupAttrs.sourceType,
          tags: Array.from(new Set([...groupAttrs.tags, ...itemAttrs.tags])),
        };

        const eMatch = epCombined.match(EPISODE_REGEX);
        const epNum = eMatch ? parseInt(eMatch[1], 10) : null;

        const sizeMatch = epCombined.match(FILE_SIZE_REGEX);
        const fileSize = sizeMatch ? sizeMatch[1] : undefined;

        const downloadLinks = extractButtonsFromContainer($epItem);
        if (downloadLinks.length === 0) return;

        const epBadge = epNum !== null ? `E${String(epNum).padStart(2, '0')}` : '';
        const baseLabel = buildReleaseLabel(mergedAttrs, epTitle || groupCombined);
        const label = epBadge ? `${epBadge} • ${baseLabel}` : baseLabel;

        allReleases.push({
          label,
          quality: {
            normalized: mergedAttrs.resolution || 'unknown',
            original: mergedAttrs.originalResolution || mergedAttrs.resolution || 'unknown',
          },
          resolution: mergedAttrs.resolution,
          codec: mergedAttrs.codec,
          dynamicRange: mergedAttrs.dynamicRange,
          bitDepth: mergedAttrs.bitDepth,
          sourceType: mergedAttrs.sourceType,
          tags: mergedAttrs.tags,
          audioLanguages: groupAudios,
          fileSize,
          filename: epFileTitle || undefined,
          scope: 'episode',
          season: groupSeason,
          episode: epNum,
          downloadLinks,
        });
      });
    });
  }

  // ─── 2. Movie Extraction or Fallback Release Extraction ────────────────────
  if (allReleases.length === 0 || contentType === 'movie') {
    $('.download-item').each((_, itemEl) => {
      const $item = $(itemEl);
      const headerText = $item.find('.download-header').text().trim().replace(/\s+/g, ' ');
      const fileTitle = $item.find('.file-title').text().trim() || headerText;
      const combinedText = `${headerText} ${fileTitle}`;

      const attrs = extractVideoAttributes(combinedText);
      const audios = extractAudioLanguages(combinedText);
      audios.forEach((a) => globalAudiosSet.add(a));

      const sizeMatch = combinedText.match(FILE_SIZE_REGEX);
      const fileSize = sizeMatch ? sizeMatch[1] : undefined;

      const downloadLinks = extractButtonsFromContainer($item);
      if (downloadLinks.length === 0) return;

      const label = buildReleaseLabel(attrs, headerText);

      allReleases.push({
        label,
        quality: {
          normalized: attrs.resolution || 'unknown',
          original: attrs.originalResolution || attrs.resolution || 'unknown',
        },
        resolution: attrs.resolution,
        codec: attrs.codec,
        dynamicRange: attrs.dynamicRange,
        bitDepth: attrs.bitDepth,
        sourceType: attrs.sourceType,
        tags: attrs.tags,
        audioLanguages: audios,
        fileSize,
        filename: fileTitle || undefined,
        scope: 'movie',
        season: null,
        episode: null,
        downloadLinks,
      });
    });
  }

  // Fallback if structured cards weren't found: collect loose download links
  if (allReleases.length === 0) {
    const pageText = $('body').text();
    const globalAudios = extractAudioLanguages(pageText);
    globalAudios.forEach((a) => globalAudiosSet.add(a));

    $('a[href]').each((_, aEl) => {
      const $a = $(aEl);
      let href = ($a.attr('href') || '').trim();
      if (!href || href === '#' || href.startsWith('javascript:')) return;

      const text = $a.text().trim();
      if (!/hubcloud|download|hubdrive/i.test(text) && !/greenmotors|fastdl|\?id=/i.test(href)) {
        return;
      }

      if (sourceUrl && !href.startsWith('http://') && !href.startsWith('https://')) {
        try {
          href = new URL(href, sourceUrl).href;
        } catch {}
      }

      const parentText = $a.closest('p, div, li').text().trim().replace(/\s+/g, ' ');
      const attrs = extractVideoAttributes(parentText || text);
      const audios = extractAudioLanguages(parentText);
      audios.forEach((a) => globalAudiosSet.add(a));

      const label = buildReleaseLabel(attrs, text);

      allReleases.push({
        label,
        quality: {
          normalized: attrs.resolution || 'unknown',
          original: attrs.originalResolution || attrs.resolution || 'unknown',
        },
        resolution: attrs.resolution,
        codec: attrs.codec,
        dynamicRange: attrs.dynamicRange,
        bitDepth: attrs.bitDepth,
        sourceType: attrs.sourceType,
        tags: attrs.tags,
        audioLanguages: audios.length > 0 ? audios : globalAudios,
        scope: contentType === 'series' ? 'episode' : 'movie',
        season: null,
        episode: null,
        downloadLinks: [
          {
            provider: /hubdrive/i.test(text) ? 'HubDrive' : 'HubCloud',
            label: text || 'Download HubCloud',
            url: href,
            isDirectDestination: isHubCloudDriveUrl(href),
          },
        ],
      });
    });
  }

  // ─── 3. Grouping & Deduplication ──────────────────────────────────────────

  // Extract all dynamic seasons (Section 10)
  const seasonsMap = new Map();
  for (const rel of allReleases) {
    if (rel.season !== null && rel.season !== undefined) {
      if (!seasonsMap.has(rel.season)) {
        seasonsMap.set(rel.season, []);
      }
      seasonsMap.get(rel.season).push(rel);
    }
  }

  // Sort seasons numerically (e.g. 1 to 8 or 8 down to 1)
  const sortedSeasonNumbers = Array.from(seasonsMap.keys()).sort((a, b) => b - a);
  const seasons = sortedSeasonNumbers.map((num) => ({
    number: num,
    releases: seasonsMap.get(num),
  }));

  // Group by normalized quality for quality overview (Section 5, 28)
  const qualitiesMap = new Map();
  for (const rel of allReleases) {
    const res = rel.quality.normalized || 'Other';
    if (!qualitiesMap.has(res)) {
      qualitiesMap.set(res, []);
    }
    qualitiesMap.get(res).push(rel);
  }

  // Order qualities logically: 2160p, 1080p, 720p, 480p, others
  const qualityPriority = ['2160p', '1080p', '720p', '480p'];
  const sortedQualityKeys = Array.from(qualitiesMap.keys()).sort((a, b) => {
    const idxA = qualityPriority.indexOf(a);
    const idxB = qualityPriority.indexOf(b);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.localeCompare(b);
  });

  const qualities = sortedQualityKeys.map((res) => ({
    resolution: res,
    releases: qualitiesMap.get(res),
  }));

  const totalLinks = allReleases.reduce((sum, r) => sum + (r.downloadLinks?.length || 0), 0);

  logger.log('4KHub4U', `[4KHub4U] metadata parsed for "${cleanTitle}"`);
  if (seasons.length > 0) {
    logger.log('4KHub4U', `[4KHub4U] seasons discovered: ${seasons.length}`);
  }
  logger.log('4KHub4U', `[4KHub4U] quality variants discovered: ${allReleases.length}`);
  logger.log('4KHub4U', `[4KHub4U] download links discovered: ${totalLinks}`);

  return {
    source: '4khub4u',
    sourceUrl,
    title: cleanTitle,
    type: contentType,
    year,
    audioLanguages: Array.from(globalAudiosSet),
    qualities,
    seasons,
    totalReleases: allReleases.length,
    totalLinks,
    extractedAt: Date.now(),
  };
}

/**
 * Asynchronously resolves mediator links across all releases in a catalogue
 * to their direct HubCloud / HubDrive destinations via bounded concurrent HTTP inspection.
 *
 * @param {object} catalogue The parsed catalogue
 * @param {object} [options]
 * @param {number} [options.concurrency=25] Max concurrent HTTP requests
 * @param {number} [options.timeout=3500] Request timeout per mediator URL
 * @returns {Promise<object>} The catalogue with resolved download links
 */
export async function resolveCatalogueLinks(catalogue, options = {}) {
  if (!catalogue) return catalogue;

  const concurrency = options.concurrency || 25;
  const timeout = options.timeout || 3500;

  const allReleases =
    catalogue.type === 'series' && Array.isArray(catalogue.seasons)
      ? catalogue.seasons.flatMap((s) => s.releases || [])
      : Array.isArray(catalogue.qualities)
      ? catalogue.qualities.flatMap((q) => q.releases || [])
      : [];

  const allLinks = allReleases.flatMap((r) => r.downloadLinks || []);

  const urlMap = new Map();
  for (const link of allLinks) {
    // Exclude HubDrive links from resolution - only resolve HubCloud links
    const isHubDrive =
      link.provider === 'HubDrive' ||
      /hubdrive/i.test(link.label || '') ||
      /hubdrive/i.test(link.url || '');
    if (isHubDrive) continue;

    if (link.url && !link.isDirectDestination && !link.resolvedUrl) {
      if (!urlMap.has(link.url)) {
        urlMap.set(link.url, []);
      }
      urlMap.get(link.url).push(link);
    }
  }

  const uniqueUrls = Array.from(urlMap.keys());
  if (uniqueUrls.length === 0) return catalogue;

  logger.log('4KHub4U', `[4KHub4U] Resolving ${uniqueUrls.length} unique HubCloud mediator links via HTTP inspection...`);
  const t0 = Date.now();
  let index = 0;
  let resolvedCount = 0;

  async function worker() {
    while (index < uniqueUrls.length) {
      const url = uniqueUrls[index++];
      try {
        const res = await fetchWithControls(url, { timeout, maxRetries: 1 });
        if (res.body) {
          const dest = extractEmbeddedMediatorPayload(res.body);
          if (dest) {
            const targetLinks = urlMap.get(url) || [];
            for (const tl of targetLinks) {
              tl.resolvedUrl = dest;
              tl.url = dest; // Point directly to verified storage link
              tl.isDirectDestination = true;
              if (/hubdrive/i.test(dest)) {
                tl.provider = 'HubDrive';
              } else if (/hubcloud/i.test(dest)) {
                tl.provider = 'HubCloud';
              }
            }
            resolvedCount++;
          } else {
            const isDead = INVALID_LINK_PATTERNS.some((p) => p.test(res.body));
            if (isDead) {
              const targetLinks = urlMap.get(url) || [];
              for (const tl of targetLinks) {
                tl.isInvalid = true;
                tl.error = 'Upstream mediator link expired on source site';
              }
            }
          }
        }
      } catch (err) {
        // Keep fallback to original URL on network error or timeout
      }
    }
  }

  const workerCount = Math.min(concurrency, uniqueUrls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  logger.log('4KHub4U', `[4KHub4U] Resolved ${resolvedCount}/${uniqueUrls.length} HubCloud links directly to storage in ${Date.now() - t0}ms`);

  return catalogue;
}

export default {
  extractVideoAttributes,
  extractAudioLanguages,
  buildReleaseLabel,
  parse4KHubCatalogue,
  resolveCatalogueLinks,
};
