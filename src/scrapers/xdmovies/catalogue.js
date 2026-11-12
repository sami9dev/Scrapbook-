/**
 * XDMovies Catalogue Parser
 *
 * Extracts structured release catalogue from XDMovies pages (e.g. huh.xdmovies.wtf, top.xdmovies.wtf).
 * Supports both modern SPA/Grid layout (.download-item, .pack-card, .episode-card)
 * and legacy WordPress/heading-based layouts.
 */

import * as cheerio from 'cheerio';
import { logger } from '../../logging/logger.js';

// ─── Pattern Definitions ──────────────────────────────────────────────────────

const RESOLUTION_PATTERNS = [
  { normalized: '2160p', regex: /\b(2160p|4k|uhd)\b/i },
  { normalized: '1080p', regex: /\b(1080p|fhd)\b/i },
  { normalized: '720p',  regex: /\b(720p|hd)\b/i },
  { normalized: '480p',  regex: /\b(480p|sd)\b/i },
];

const CODEC_PATTERNS = [
  { label: 'AV1',  regex: /\bav1\b/i },
  { label: 'HEVC', regex: /\b(hevc|x265|h\.?265)\b/i },
  { label: 'x264', regex: /\b(x264|h\.?264|avc)\b/i },
];

const DYNAMIC_RANGE_PATTERNS = [
  { label: 'Dolby Vision + HDR', regex: /\b(?:dovi[\s_-]*hdr|dv[\s_-]*hdr|hdr[\s_-]*dv)\b/i },
  { label: 'Dolby Vision',       regex: /\b(?:dolby\s*vision|dovi|dv)\b/i },
  { label: 'HDR10+',             regex: /\bhdr10\+\b/i },
  { label: 'HDR10',              regex: /\bhdr10\b/i },
  { label: 'HDR',                regex: /\bhdr\b/i },
];

const SOURCE_TYPE_PATTERNS = [
  { label: 'REMUX',  regex: /\bremux\b/i },
  { label: 'BluRay', regex: /\b(bluray|bdrip|brrip)\b/i },
  { label: 'WEB-DL', regex: /\bweb[\s-]?dl\b/i },
  { label: 'WEBRip', regex: /\bwebrip\b/i },
  { label: 'HDTV',   regex: /\bhdtv\b/i },
];

const AUDIO_LANGUAGES = [
  'Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam',
  'Kannada', 'Bengali', 'Marathi', 'Punjabi', 'Gujarati',
  'Urdu', 'Japanese', 'Korean', 'Chinese', 'Spanish',
  'French', 'German', 'Italian', 'Russian', 'Portuguese',
];

const AUDIO_FORMAT_PATTERNS = [
  { label: 'Atmos',  regex: /\batmos\b/i },
  { label: 'DDP5.1', regex: /\bddp\s*5\.1\b/i },
  { label: 'DD+',    regex: /\bdd\+\b/i },
  { label: 'DDP',    regex: /\bddp\b/i },
  { label: 'DD5.1',  regex: /\bdd\s*5\.1\b/i },
  { label: 'AAC5.1', regex: /\baac\s*5\.1\b/i },
  { label: 'DTS-HD', regex: /\bdts[\s-]hd\b/i },
  { label: 'DTS',    regex: /\bdts\b/i },
  { label: 'TrueHD', regex: /\btruehd\b/i },
  { label: 'AAC',    regex: /\baac\b/i },
];

const FILE_SIZE_REGEX = /\b(\d+(?:\.\d+)?\s*(?:GB|MB))\b/i;
const SEASON_REGEX    = /\bS(?:eason\s*)?(\d{1,2})(?=[eE\s._\-\]()]|$)/i;
const EPISODE_REGEX   = /(?:\b|(?<=[sS]\d{1,2}))E(?:pisode\s*)?(\d{1,3})\b/i;

const PROVIDER_PATTERNS = [
  { name: 'XDMovies Link', regex: /link\.xdmovies|xdmovies\.wtf\/download/i },
  { name: 'HubCloud',      regex: /hubcloud|hubdrive|hub\.wtf/i },
  { name: 'GDFlix',        regex: /gdflix/i },
  { name: 'VCloud',        regex: /vcloud|v-cloud/i },
  { name: 'Nexdrive',      regex: /nexdrive/i },
  { name: 'FastDL',        regex: /fastdl|fast-dl/i },
  { name: 'DriveBot',      regex: /drivebot/i },
  { name: 'DriveSeed',     regex: /driveseed/i },
  { name: 'PixelDrain',    regex: /pixeldrain/i },
  { name: 'GoFile',        regex: /gofile/i },
];

const SKIP_HREF_PATTERN = /how-to-download|tutorial|wp-login|wp-admin|\/feed|\/tag\/|category|uncategorized|\/genre\/|\/quality\/|\/year\/|\/author\/|privacy-policy|contact-us|dmca|terms|javascript:|mailto:|#$/i;

// ─── Attribute Extractors ─────────────────────────────────────────────────────

export function extractVideoAttributes(text = '') {
  let resolution, originalResolution;
  for (const { normalized, regex } of RESOLUTION_PATTERNS) {
    const m = text.match(regex);
    if (m) { resolution = normalized; originalResolution = m[0]; break; }
  }

  let codec;
  for (const { label, regex } of CODEC_PATTERNS) {
    if (regex.test(text)) { codec = label; break; }
  }

  const hasDV       = /\b(?:dolby[\s_.-]*vision|dovi|dv)\b/i.test(text);
  const hasHDR10p   = /\bhdr10\+\b/i.test(text);
  const hasHDR10    = /\bhdr10\b/i.test(text);
  const hasHDR      = /\bhdr\b/i.test(text);

  let dynamicRange;
  if (hasDV && (hasHDR || hasHDR10 || hasHDR10p)) dynamicRange = 'Dolby Vision + HDR';
  else if (hasDV)    dynamicRange = 'Dolby Vision';
  else if (hasHDR10p) dynamicRange = 'HDR10+';
  else if (hasHDR10)  dynamicRange = 'HDR10';
  else if (hasHDR)    dynamicRange = 'HDR';

  let sourceType;
  for (const { label, regex } of SOURCE_TYPE_PATTERNS) {
    if (regex.test(text)) { sourceType = label; break; }
  }

  if (!dynamicRange && (resolution || codec || sourceType)) {
    dynamicRange = 'SDR';
  }

  return { resolution, originalResolution, codec, dynamicRange, sourceType };
}

export function extractAudioInfo(text = '') {
  const languages = [];
  for (const lang of AUDIO_LANGUAGES) {
    if (new RegExp(`\\b${lang}\\b`, 'i').test(text)) languages.push(lang);
  }

  if (/\bmulti(?:-?audio)?\b/i.test(text) && !languages.includes('MULTI')) languages.unshift('MULTI');
  if (/\bdual(?:-?audio)?\b/i.test(text) && !languages.includes('Dual-Audio')) languages.unshift('Dual-Audio');

  const formats = [];
  for (const { label, regex } of AUDIO_FORMAT_PATTERNS) {
    if (regex.test(text)) formats.push(label);
  }

  return { languages, formats };
}

export function detectProvider(url = '', text = '') {
  const combined = `${url} ${text}`;
  for (const { name, regex } of PROVIDER_PATTERNS) {
    if (regex.test(combined)) return name;
  }
  return 'Direct';
}

export function buildLabel(attrs, fallback = '') {
  const parts = [];
  if (attrs.resolution)   parts.push(attrs.resolution);
  if (attrs.dynamicRange && attrs.dynamicRange !== 'SDR') parts.push(attrs.dynamicRange);
  if (attrs.sourceType)   parts.push(attrs.sourceType);
  if (attrs.codec)        parts.push(attrs.codec);
  return parts.length > 0 ? parts.join(' ') : (fallback.trim() || 'Standard Release');
}

// ─── Main Parser ──────────────────────────────────────────────────────────────

/**
 * Parses an XDMovies movie or series page HTML into a structured catalogue.
 *
 * @param {string} html     Raw page HTML
 * @param {string} sourceUrl Page URL
 * @returns {object}
 */
export function parseXDMoviesCatalogue(html, sourceUrl = '') {
  if (!html || typeof html !== 'string') {
    throw new Error('Invalid HTML provided to parseXDMoviesCatalogue');
  }

  const $ = cheerio.load(html);

  // ── Title Extraction ───────────────────────────────────────────────────────
  const rawTitle =
    $('h2:not(:contains("How to Download"))').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('h1.entry-title, h1').first().text().trim() ||
    $('title').text().trim() ||
    '';

  const cleanTitle = rawTitle
    .replace(/\s*[-–|]\s*(XDMovies|Download|Free|Series|Movie).*$/i, '')
    .replace(/\b(19\d{2}|20\d{2})\b/g, '')
    .replace(/\b(complete|pack|2160p|4k|1080p|720p|480p|web-dl|bluray|hevc|h\.?265|x264|hdr|sdr)\b/gi, '')
    .replace(/[\[\]()\-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || rawTitle;

  // ── Year ──────────────────────────────────────────────────────────────────
  const yearMatch = (rawTitle + ' ' + $('title').text() + ' ' + $('body').text().slice(0, 2000)).match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : undefined;

  // ── Content Type ──────────────────────────────────────────────────────────
  const isSeries =
    /\/(series|tv|shows?)\//i.test(sourceUrl) ||
    /series|season|episode|S\d{1,2}E\d{1,2}/i.test(rawTitle) ||
    $('.packs-grid, .episode-card, [id*="season"]').length > 0;
  const contentType = isSeries ? 'series' : 'movie';

  logger.log('XDMovies', `[XDMovies] parsing "${cleanTitle}" (${contentType}) from ${sourceUrl}`);

  const allReleases = [];
  const seenUrls = new Set();

  // ── PASS 1: Modern XDMovies SPA / Grid Components ──────────────────────────

  // 1A. Movie Download Items (.download-item)
  $('.download-item').each((_, itemEl) => {
    const $item = $(itemEl);
    const releaseTitle = $item.find('.custom-title').text().trim() || $item.text().trim();
    const $link = $item.find('a[href]').first();
    const href = ($link.attr('href') || '').trim();
    if (!href || SKIP_HREF_PATTERN.test(href) || seenUrls.has(href)) return;
    seenUrls.add(href);

    const linkText = $link.text().trim();
    const sizeM = linkText.match(FILE_SIZE_REGEX) || releaseTitle.match(FILE_SIZE_REGEX) || $item.find('.file-size, .size').text().match(FILE_SIZE_REGEX) || $item.text().match(FILE_SIZE_REGEX);
    const fileSize = sizeM ? sizeM[1] : undefined;

    const attrs = extractVideoAttributes(releaseTitle);
    const audio = extractAudioInfo(releaseTitle);
    const provider = detectProvider(href, linkText);

    allReleases.push({
      label: releaseTitle || buildLabel(attrs, 'Movie Release'),
      sectionTitle: releaseTitle,
      quality: {
        normalized: attrs.resolution || 'unknown',
        original: attrs.originalResolution || attrs.resolution || 'unknown',
      },
      resolution: attrs.resolution,
      codec: attrs.codec,
      dynamicRange: attrs.dynamicRange,
      sourceType: attrs.sourceType,
      audioLanguages: audio.languages,
      audioFormats: audio.formats,
      fileSize,
      season: null,
      episode: null,
      scope: 'movie',
      downloadLinks: [{ provider, label: linkText || provider, url: href, isDirectDestination: false }],
    });
  });

  // 1B. Series Season Packs (.pack-card, .pack-info)
  $('.pack-card, .pack-info').each((_, packEl) => {
    const $pack = $(packEl);
    const releaseTitle = $pack.find('.pack-title, h4').first().text().trim() || $pack.text().trim();
    const $link = $pack.find('a[href]').first();
    const href = ($link.attr('href') || '').trim();
    if (!href || SKIP_HREF_PATTERN.test(href) || seenUrls.has(href)) return;
    seenUrls.add(href);

    const linkText = $link.text().trim();
    const sizeM = linkText.match(FILE_SIZE_REGEX) || releaseTitle.match(FILE_SIZE_REGEX) || $pack.find('.file-size, .size').text().match(FILE_SIZE_REGEX) || $pack.text().match(FILE_SIZE_REGEX);
    const fileSize = sizeM ? sizeM[1] : undefined;

    const seasonM = releaseTitle.match(SEASON_REGEX) || $pack.closest('[id*="season"]').attr('id')?.match(/season.*?(\d+)/i);
    const season = seasonM ? parseInt(seasonM[1], 10) : 1;

    const attrs = extractVideoAttributes(releaseTitle);
    const audio = extractAudioInfo(releaseTitle);
    const provider = detectProvider(href, linkText);

    allReleases.push({
      label: releaseTitle || buildLabel(attrs, `Season ${season} Complete Pack`),
      sectionTitle: releaseTitle,
      quality: {
        normalized: attrs.resolution || 'unknown',
        original: attrs.originalResolution || attrs.resolution || 'unknown',
      },
      resolution: attrs.resolution,
      codec: attrs.codec,
      dynamicRange: attrs.dynamicRange,
      sourceType: attrs.sourceType,
      audioLanguages: audio.languages,
      audioFormats: audio.formats,
      fileSize,
      season,
      episode: null,
      scope: 'pack',
      downloadLinks: [{ provider, label: linkText || provider, url: href, isDirectDestination: false }],
    });
  });

  // 1C. Series Individual Episodes (.episode-card)
  $('.episode-card').each((_, cardEl) => {
    const $card = $(cardEl);
    const releaseTitle = $card.find('.episode-title').first().text().trim() || $card.text().trim();
    const $link = $card.find('a[href]').first();
    const href = ($link.attr('href') || '').trim();
    if (!href || SKIP_HREF_PATTERN.test(href) || seenUrls.has(href)) return;
    seenUrls.add(href);

    const linkText = $link.text().trim();
    const sizeM = linkText.match(FILE_SIZE_REGEX) || releaseTitle.match(FILE_SIZE_REGEX) || $card.find('.file-size, .size').text().match(FILE_SIZE_REGEX) || $card.text().match(FILE_SIZE_REGEX);
    const fileSize = sizeM ? sizeM[1] : undefined;

    const seasonM = releaseTitle.match(SEASON_REGEX) || $card.closest('[id*="season"]').attr('id')?.match(/season.*?(\d+)/i);
    const episodeM = releaseTitle.match(EPISODE_REGEX);
    const season = seasonM ? parseInt(seasonM[1], 10) : 1;
    const episode = episodeM ? parseInt(episodeM[1], 10) : null;

    const codecBadge = $card.find('.codec-badge').text().trim();
    const fullText = `${releaseTitle} ${codecBadge}`;

    const attrs = extractVideoAttributes(fullText);
    const audio = extractAudioInfo(fullText);
    const provider = detectProvider(href, linkText);

    allReleases.push({
      label: releaseTitle || buildLabel(attrs, `S${String(season).padStart(2, '0')}E${String(episode || 0).padStart(2, '0')}`),
      sectionTitle: releaseTitle,
      quality: {
        normalized: attrs.resolution || 'unknown',
        original: attrs.originalResolution || attrs.resolution || 'unknown',
      },
      resolution: attrs.resolution,
      codec: attrs.codec || (codecBadge || undefined),
      dynamicRange: attrs.dynamicRange,
      sourceType: attrs.sourceType,
      audioLanguages: audio.languages,
      audioFormats: audio.formats,
      fileSize,
      season,
      episode,
      scope: 'episode',
      downloadLinks: [{ provider, label: linkText || provider, url: href, isDirectDestination: false }],
    });
  });

  // ── PASS 2: Legacy WordPress / Heading-Scoped Fallback ─────────────────────
  if (allReleases.length === 0) {
    const headings = [];
    $('h2, h3, h4, h5, h6').each((_, el) => {
      headings.push({ el, text: $(el).text().trim() });
    });

    for (let hi = 0; hi < headings.length; hi++) {
      const hEl = headings[hi].el;
      const hText = headings[hi].text;
      if (/related|comment|share|popular|recommended|navigation|menu|sidebar|how to download/i.test(hText)) continue;

      const attrs = extractVideoAttributes(hText);
      const audio = extractAudioInfo(hText);
      const sizeM = hText.match(FILE_SIZE_REGEX);
      const fileSize = sizeM ? sizeM[1] : undefined;

      const seasonM  = hText.match(SEASON_REGEX);
      const episodeM = hText.match(EPISODE_REGEX);
      const season   = seasonM  ? parseInt(seasonM[1],  10) : null;
      const episode  = episodeM ? parseInt(episodeM[1], 10) : null;

      const linkEls = [];
      let sibling = $(hEl).next();
      while (sibling.length > 0 && !sibling.is('h2,h3,h4,h5,h6')) {
        sibling.find('a[href]').addBack('a[href]').each((_, a) => linkEls.push(a));
        sibling = sibling.next();
      }

      const downloadLinks = [];
      for (const aEl of linkEls) {
        const $a = $(aEl);
        const href = ($a.attr('href') || '').trim();
        if (!href || SKIP_HREF_PATTERN.test(href) || seenUrls.has(href)) continue;
        seenUrls.add(href);

        const linkText = $a.text().trim();
        const provider = detectProvider(href, linkText);
        downloadLinks.push({ provider, label: linkText || provider, url: href, isDirectDestination: false });
      }

      if (downloadLinks.length === 0) continue;

      const scope = episode !== null ? 'episode' : season !== null ? 'pack' : (contentType === 'movie' ? 'movie' : 'episode');

      allReleases.push({
        label: buildLabel(attrs, hText),
        sectionTitle: hText,
        quality: {
          normalized: attrs.resolution || 'unknown',
          original: attrs.originalResolution || attrs.resolution || 'unknown',
        },
        resolution: attrs.resolution,
        codec: attrs.codec,
        dynamicRange: attrs.dynamicRange,
        sourceType: attrs.sourceType,
        audioLanguages: audio.languages,
        audioFormats: audio.formats,
        fileSize,
        season,
        episode,
        scope,
        downloadLinks,
      });
    }
  }

  // ── PASS 3: Global Link Fallback (e.g. any link.xdmovies links) ───────────
  if (allReleases.length === 0) {
    $('a[href*="link.xdmovies"], a.movie-download-btn, a.download-button').each((_, aEl) => {
      const $a = $(aEl);
      const href = ($a.attr('href') || '').trim();
      if (!href || SKIP_HREF_PATTERN.test(href) || seenUrls.has(href)) return;
      seenUrls.add(href);

      const linkText = $a.text().trim();
      const parentText = $a.closest('p, div, li, td').text().trim();
      const attrs = extractVideoAttributes(parentText);
      const sizeM = parentText.match(FILE_SIZE_REGEX);
      const provider = detectProvider(href, linkText);

      allReleases.push({
        label: buildLabel(attrs, linkText || 'Download Link'),
        sectionTitle: null,
        quality: {
          normalized: attrs.resolution || 'unknown',
          original: attrs.originalResolution || attrs.resolution || 'unknown',
        },
        resolution: attrs.resolution,
        codec: attrs.codec,
        dynamicRange: attrs.dynamicRange,
        sourceType: attrs.sourceType,
        audioLanguages: [],
        audioFormats: [],
        fileSize: sizeM ? sizeM[1] : undefined,
        season: null,
        episode: null,
        scope: contentType === 'movie' ? 'movie' : 'episode',
        downloadLinks: [{ provider, label: linkText || provider, url: href, isDirectDestination: false }],
      });
    });
  }

  // ── Grouping into Seasons & Qualities ──────────────────────────────────────
  const seasonsMap = new Map();
  for (const rel of allReleases) {
    if (rel.season !== null && rel.season !== undefined) {
      if (!seasonsMap.has(rel.season)) seasonsMap.set(rel.season, []);
      seasonsMap.get(rel.season).push(rel);
    }
  }

  const seasons = Array.from(seasonsMap.keys())
    .sort((a, b) => a - b)
    .map(num => ({ number: num, releases: seasonsMap.get(num) }));

  const qualitiesMap = new Map();
  for (const rel of allReleases) {
    const res = rel.quality.normalized || 'Other';
    if (!qualitiesMap.has(res)) qualitiesMap.set(res, []);
    qualitiesMap.get(res).push(rel);
  }

  const qualityOrder = ['2160p', '1080p', '720p', '480p'];
  const qualities = Array.from(qualitiesMap.keys())
    .sort((a, b) => {
      const ai = qualityOrder.indexOf(a), bi = qualityOrder.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    })
    .map(res => ({ resolution: res, releases: qualitiesMap.get(res) }));

  const totalLinks = allReleases.reduce((s, r) => s + (r.downloadLinks?.length || 0), 0);

  logger.log('XDMovies', `[XDMovies] "${cleanTitle}" — ${allReleases.length} releases, ${totalLinks} links`);

  return {
    source: 'xdmovies',
    sourceUrl,
    title: cleanTitle,
    rawTitle,
    type: contentType,
    year,
    qualities,
    seasons,
    totalReleases: allReleases.length,
    totalLinks,
    extractedAt: Date.now(),
  };
}

export default { parseXDMoviesCatalogue, extractVideoAttributes, extractAudioInfo, detectProvider, buildLabel };
