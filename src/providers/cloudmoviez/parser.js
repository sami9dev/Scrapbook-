import * as cheerio from 'cheerio';

/**
 * Extracts clean title from the Cheerio document.
 * 
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
export function extractPageTitle($) {
  const h1 = $('h1.entry-title, h1').first().text().trim();
  if (h1) return h1;

  const docTitle = $('title').text().trim();
  if (docTitle) {
    return docTitle
      .replace(/\s*[-–|]\s*(?:CloudMoviez|CloudMovieZ|Free HD Movies|300mb|480p|720p|1080p|Download).*$/i, '')
      .trim();
  }

  return 'Unknown Title';
}

/**
 * Decodes the base64 JSON payload embedded in a CloudMoviez file parameter.
 * e.g. https://c1.cloudmoviez.shop/?file=eyJ1cmwiOiJodHRwczpcL1wvZ2RmbGl4LmRldlwvZmlsZVwvYklvbVo1QzBBUHBNa0k4IiwicG9zdCI6ODkyNDUsInRpdGxlIjoiR0RGTElYIn0=
 * Decodes to: { url: 'https://gdflix.dev/file/bIomZ5C0APpMkI8', post: 89245, title: 'GDFLIX' }
 * 
 * @param {string} urlOrParam
 * @returns {{ url: string, post: number|null, title: string|null } | null}
 */
export function decodeFilePayload(urlOrParam) {
  if (!urlOrParam || typeof urlOrParam !== 'string') return null;

  let base64Str = urlOrParam;
  if (urlOrParam.includes('?file=')) {
    base64Str = urlOrParam.split('?file=')[1].split('&')[0];
  } else if (urlOrParam.includes('&file=')) {
    base64Str = urlOrParam.split('&file=')[1].split('&')[0];
  }

  try {
    const raw = Buffer.from(base64Str, 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.url === 'string') {
      return {
        url: parsed.url,
        post: parsed.post ?? null,
        title: parsed.title ?? null,
      };
    }
  } catch {
    // Return null if invalid base64 or JSON
  }

  return null;
}

/**
 * Normalizes quality string from text or title.
 * 
 * @param {string} text
 * @returns {string|null}
 */
export function detectQuality(text) {
  if (!text) return null;
  const match = text.match(/\b(2160p|4k|1080p|720p|480p|576p|uhd)\b/i);
  if (!match) return null;
  const val = match[1].toLowerCase();
  if (val === '4k' || val === 'uhd') return '2160p';
  return val;
}

/**
 * Detects codec from text.
 * 
 * @param {string} text
 * @returns {string|null}
 */
export function detectCodec(text) {
  if (!text) return null;
  if (/\b(h\.?265|hevc|x265)\b/i.test(text)) return 'H.265';
  if (/\b(h\.?264|avc|x264)\b/i.test(text)) return 'H.264';
  if (/\b(av1)\b/i.test(text)) return 'AV1';
  if (/\b(10bit)\b/i.test(text)) return '10bit';
  return null;
}

/**
 * Accurately detects Season and Episode without falsely matching Downscaled 4K ("DS4K") as Season 4.
 * 
 * @param {string} text
 * @returns {{ season: number|null, episode: number|null }}
 */
export function detectSeasonEpisode(text) {
  if (!text) return { season: null, episode: null };

  // Remove false-positive tokens like DS4K / DS-4K / 4K
  const sanitized = text.replace(/\bds4k\b/gi, '').replace(/\b4k\b/gi, '');

  let season = null;
  let episode = null;

  // Pattern: S01E02, S1 E2, S01-E02
  const sMatch = sanitized.match(/(?:^|[^a-zA-Z0-9])s(\d{1,2})[\s._-]*e(\d{1,3})\b/i);
  if (sMatch) {
    season = parseInt(sMatch[1], 10);
    episode = parseInt(sMatch[2], 10);
    return { season, episode };
  }

  // Pattern: Season 1 Episode 2
  const seMatch = sanitized.match(/\bseason\s*(\d{1,2})[\s._-]+episode\s*(\d{1,3})\b/i);
  if (seMatch) {
    season = parseInt(seMatch[1], 10);
    episode = parseInt(seMatch[2], 10);
    return { season, episode };
  }

  // Episode only: Episode 1, Ep 01, E01 (excluding general letters)
  const epMatch = sanitized.match(/(?:^|[^a-zA-Z0-9])(?:episode|ep)[\s._-]*(\d{1,3})\b/i);
  if (epMatch) {
    episode = parseInt(epMatch[1], 10);
  }

  // Season only: Season 1, S01
  const sOnly = sanitized.match(/(?:^|[^a-zA-Z0-9])(?:season\s*|s)(\d{1,2})\b/i);
  if (sOnly) {
    season = parseInt(sOnly[1], 10);
  }

  return { season, episode };
}

/**
 * Detects whether the URL indicates a movie or TV show.
 * 
 * @param {string} url
 * @returns {'movie'|'series'|null}
 */
export function detectContentTypeFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (/\/movies?\//i.test(url)) return 'movie';
  if (/\/tvshows?\//i.test(url) || /\/series\//i.test(url)) return 'series';
  return null;
}

/**
 * Extracts file size string from button element or text.
 * e.g. <a ...><span>G</span>19.47 GB</a> -> "19.47 GB"
 * 
 * @param {import('cheerio').Cheerio<any>} $el
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string|null}
 */
export function extractButtonSize($el, $) {
  // Clone element to avoid modifying DOM, then remove child tags like <span> icon
  const clone = $el.clone();
  clone.children().remove();
  const text = clone.text().trim();
  const match = text.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB))/i);
  if (match) {
    return match[1].toUpperCase();
  }

  // Fallback to full text match
  const fullText = $el.text().trim();
  const fullMatch = fullText.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB))/i);
  return fullMatch ? fullMatch[1].toUpperCase() : null;
}

export default {
  extractPageTitle,
  decodeFilePayload,
  detectQuality,
  detectCodec,
  detectSeasonEpisode,
  detectContentTypeFromUrl,
  extractButtonSize,
};
