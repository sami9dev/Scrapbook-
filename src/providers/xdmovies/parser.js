import * as cheerio from 'cheerio';

/**
 * Extracts video quality (2160p, 1080p, 720p, 480p) from text or filename.
 * 
 * @param {string} text 
 * @returns {string}
 */
export function extractQuality(text) {
  if (!text) return 'unknown';
  if (/2160p|4k|uhd/i.test(text)) return '2160p';
  if (/1080p|fhd/i.test(text)) return '1080p';
  if (/720p|hd\b/i.test(text)) return '720p';
  if (/480p|sd\b/i.test(text)) return '480p';
  return 'unknown';
}

/**
 * Extracts codec or format (H.265, H.264, SDR, HDR) from text.
 * 
 * @param {string} text 
 * @returns {string|null}
 */
export function extractCodec(text) {
  if (!text) return null;
  if (/h\.?265|hevc/i.test(text)) return 'H.265';
  if (/h\.?264|avc/i.test(text)) return 'H.264';
  if (/\bsdr\b/i.test(text)) return 'SDR';
  if (/\bhdr(?:10(?:\+)?)?\b|dolby\s*vision|\bdv\b/i.test(text)) return 'HDR';
  return null;
}

/**
 * Parses an XDMovies (top.xdmovies.wtf) HTML document.
 * Extracts title, OTT/source, audio languages, season packs, and individual episodes.
 * 
 * @param {string} html Raw HTML content
 * @param {string} [sourceUrl] The page URL
 * @returns {{
 *   title: string,
 *   type: 'tv' | 'movie',
 *   audios: string[],
 *   ottSource: string|null,
 *   links: Array<{
 *     title: string,
 *     filename: string,
 *     scope: 'pack' | 'episode' | 'movie',
 *     season: number|null,
 *     episode: number|null,
 *     quality: string,
 *     codec: string|null,
 *     sizeDisplay: string|null,
 *     redirectUrl: string,
 *     provider: string,
 *     sourceUrl: string
 *   }>
 * }}
 */
export function parseXDMoviesPage(html, sourceUrl = '') {
  if (!html || typeof html !== 'string') {
    return { title: 'Unknown Title', type: 'movie', audios: [], ottSource: null, links: [] };
  }

  const $ = cheerio.load(html);

  // Extract Title
  let pageTitle = $('h2').first().text().trim();
  if (!pageTitle) {
    const rawTitle = $('title').text().trim();
    pageTitle = rawTitle.replace(/[—–-].*$/, '').trim();
  }
  pageTitle = pageTitle || 'XDMovies Release';

  // Detect content type
  const isSeries = sourceUrl.includes('/series/') || $('.seasons-container, .season-section, .episode-card').length > 0;
  const contentType = isSeries ? 'tv' : 'movie';

  // Extract Audios
  const audios = [];
  const audioText = $('.neon-audio').text().trim();
  if (audioText) {
    audioText.split(',').forEach((a) => {
      const trimmed = a.trim();
      if (trimmed) audios.push(trimmed);
    });
  }

  // Extract OTT Source (e.g. JioHotstar, Netflix, etc.)
  const ottSource = $('.neon-source').text().trim() || null;

  const links = [];

  // 1. Extract Complete Season Packs (.pack-card)
  $('.pack-card').each((_, el) => {
    const $card = $(el);
    const filename = $card.find('.pack-title').text().trim();
    const downloadAnchor = $card.find('a[href*="/download/"]').first();
    const redirectUrl = downloadAnchor.attr('href') || '';
    const sizeDisplay = $card.find('.size-badge').text().trim() || null;

    if (!redirectUrl) return;

    const quality = extractQuality(filename);
    const codec = extractCodec(filename);
    const seasonMatch = filename.match(/\bS(\d{1,2})\b/i);
    const season = seasonMatch ? parseInt(seasonMatch[1], 10) : 1;

    links.push({
      title: pageTitle,
      filename: filename || `${pageTitle} Season ${season} Pack`,
      scope: 'pack',
      season,
      episode: null,
      quality,
      codec,
      sizeDisplay,
      redirectUrl: redirectUrl.trim(),
      provider: 'HUBCLOUD',
      sourceUrl,
    });
  });

  // 2. Extract Individual Episodes (.episode-card)
  $('.episode-card').each((_, el) => {
    const $card = $(el);
    const filename = $card.find('.episode-title').text().trim();
    const downloadAnchor = $card.find('a[href*="/download/"]').first();
    const redirectUrl = downloadAnchor.attr('href') || '';
    const sizeText = downloadAnchor.text().trim();
    const sizeDisplay = sizeText.replace(/^[^\d]*/, '').trim() || null;
    const codecBadge = $card.find('.codec-badge').text().trim() || null;

    if (!redirectUrl) return;

    const quality = extractQuality(filename);
    const codec = codecBadge || extractCodec(filename);
    const seasonMatch = filename.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    const season = seasonMatch ? parseInt(seasonMatch[1], 10) : 1;
    const episode = seasonMatch ? parseInt(seasonMatch[2], 10) : null;

    links.push({
      title: pageTitle,
      filename: filename || `${pageTitle} S${String(season).padStart(2, '0')}E${String(episode || 1).padStart(2, '0')}`,
      scope: 'episode',
      season,
      episode,
      quality,
      codec,
      sizeDisplay,
      redirectUrl: redirectUrl.trim(),
      provider: 'HUBCLOUD',
      sourceUrl,
    });
  });

  // 3. Fallback for Single Movie Pages (if no pack-card or episode-card found)
  if (links.length === 0) {
    $('a[href*="/download/"]').each((_, el) => {
      const $a = $(el);
      const redirectUrl = $a.attr('href') || '';
      const parent = $a.closest('.download-button, .movie-card, .details-wrapper, tr, div');
      const filename = parent.find('.title, h4, h3, .pack-title').first().text().trim() || pageTitle;
      const sizeDisplay = parent.find('.size-badge, .size').first().text().trim() || null;
      const quality = extractQuality(filename);
      const codec = extractCodec(filename);

      if (!redirectUrl) return;

      links.push({
        title: pageTitle,
        filename,
        scope: 'movie',
        season: null,
        episode: null,
        quality,
        codec,
        sizeDisplay,
        redirectUrl: redirectUrl.trim(),
        provider: 'HUBCLOUD',
        sourceUrl,
      });
    });
  }

  return {
    title: pageTitle,
    type: contentType,
    audios,
    ottSource,
    links,
  };
}

export default { parseXDMoviesPage, extractQuality, extractCodec };
