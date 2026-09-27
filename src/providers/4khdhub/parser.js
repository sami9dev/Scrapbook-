import * as cheerio from 'cheerio';
import {
  HUBCLOUD_BUTTON_PATTERNS,
  QUALITY_PATTERNS,
  EPISODE_PATTERNS,
  SEASON_PATTERNS,
  LANGUAGE_PATTERNS,
} from './selectors.js';

/**
 * Extracts title from the Cheerio document.
 * 
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
export function extractPageTitle($) {
  const h1 = $('h1.entry-title, h1.post-title, h1').first().text().trim();
  if (h1) return h1;

  const docTitle = $('title').text().trim();
  if (docTitle) {
    // Strip site suffix if present (e.g. "Movie Name - 4KHDHub")
    return docTitle.replace(/\s*[-–|]\s*(?:4KHDHub|4khub4u|Download).*$/i, '').trim();
  }

  return 'Unknown Title';
}

/**
 * Detects quality from a text snippet.
 * 
 * @param {string} text
 * @returns {string|null}
 */
export function detectQualityFromText(text) {
  if (!text) return null;
  for (const { label, regex } of QUALITY_PATTERNS) {
    if (regex.test(text)) {
      return label;
    }
  }
  return null;
}

/**
 * Detects language from a text snippet.
 * 
 * @param {string} text
 * @returns {string|null}
 */
export function detectLanguageFromText(text) {
  if (!text) return null;
  for (const { label, regex } of LANGUAGE_PATTERNS) {
    if (regex.test(text)) {
      return label;
    }
  }
  return null;
}

/**
 * Detects season and episode from text.
 * 
 * @param {string} text
 * @returns {{ season: number|null, episode: number|null }}
 */
export function detectSeasonEpisodeFromText(text) {
  if (!text) return { season: null, episode: null };

  let season = null;
  let episode = null;

  for (const regex of EPISODE_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      if (match.length >= 3) {
        season = parseInt(match[1], 10);
        episode = parseInt(match[2], 10);
      } else if (match.length === 2) {
        episode = parseInt(match[1], 10);
      }
      break;
    }
  }

  if (season === null) {
    for (const regex of SEASON_PATTERNS) {
      const match = text.match(regex);
      if (match) {
        season = parseInt(match[1], 10);
        break;
      }
    }
  }

  return { season, episode };
}

/**
 * Inspects ancestor elements and previous sibling headings to infer quality and episode context.
 * 
 * @param {import('cheerio').Cheerio<any>} $el
 * @param {import('cheerio').CheerioAPI} $
 * @returns {{ quality: string|null, season: number|null, episode: number|null, language: string|null }}
 */
export function inferContextFromDOM($el, $) {
  // 1. Check immediate element and text
  const ownText = $el.text().trim();
  let quality = detectQualityFromText(ownText);
  let language = detectLanguageFromText(ownText);
  let { season, episode } = detectSeasonEpisodeFromText(ownText);

  // 2. Walk up parent containers (up to 4 levels)
  let parent = $el.parent();
  for (let i = 0; i < 4 && parent.length; i++) {
    const pText = parent.clone().children('a').remove().end().text().trim();

    if (!quality) quality = detectQualityFromText(pText);
    if (!language) language = detectLanguageFromText(pText);
    if (season === null || episode === null) {
      const se = detectSeasonEpisodeFromText(pText);
      if (season === null && se.season !== null) season = se.season;
      if (episode === null && se.episode !== null) episode = se.episode;
    }

    // Check preceding headings within container
    const prevHeading = parent.prevAll('h1, h2, h3, h4, h5, h6, p strong').first().text().trim();
    if (prevHeading) {
      if (!quality) quality = detectQualityFromText(prevHeading);
      if (!language) language = detectLanguageFromText(prevHeading);
      if (season === null || episode === null) {
        const se = detectSeasonEpisodeFromText(prevHeading);
        if (season === null && se.season !== null) season = se.season;
        if (episode === null && se.episode !== null) episode = se.episode;
      }
    }

    parent = parent.parent();
  }

  // 3. Fallback: check preceding headings globally in the document
  if (!quality || season === null) {
    const prevGlobalHeading = $el.closest('div, section, article, p')
      .prevAll('h2, h3, h4, h5, h6')
      .first()
      .text()
      .trim();

    if (prevGlobalHeading) {
      if (!quality) quality = detectQualityFromText(prevGlobalHeading);
      if (!language) language = detectLanguageFromText(prevGlobalHeading);
      if (season === null || episode === null) {
        const se = detectSeasonEpisodeFromText(prevGlobalHeading);
        if (season === null && se.season !== null) season = se.season;
        if (episode === null && se.episode !== null) episode = se.episode;
      }
    }
  }

  // 4. Extract specific file title from container (.file-title or .episode-file-title)
  let filename = null;
  const itemContainer = $el.closest('.episode-download-item, .download-item, [id^="content-"], .episode-item, .season-item');
  if (itemContainer.length) {
    const fTitle = itemContainer.find('.episode-file-title, .file-title').first().text().trim();
    if (fTitle) {
      filename = fTitle;
    }
  }

  // Detect whether it's an individual episode, a complete season pack, or a movie
  const isEpisode = episode !== null || $el.closest('#episodes, .episode-download-item, .episode-item, .episode-links').length > 0;
  const hasPackKeyword = (txt) => Boolean(txt && !/repack/i.test(txt) && /\b(zip|pack|season\s*pack|complete\s*season)\b/i.test(txt));
  const isExplicitPack = $el.closest('#complete-pack, .season-pack').length > 0
    || hasPackKeyword(ownText)
    || hasPackKeyword(filename)
    || (season !== null && episode === null);
  const scope = isEpisode ? 'episode' : (isExplicitPack ? 'pack' : 'movie');

  // If filename is found, enrich missing quality, season, and episode from filename
  if (filename) {
    if (!quality || quality === 'unknown') quality = detectQualityFromText(filename);
    if (!language) language = detectLanguageFromText(filename);
    if (season === null || episode === null) {
      const se = detectSeasonEpisodeFromText(filename);
      if (season === null && se.season !== null) season = se.season;
      if (episode === null && se.episode !== null) episode = se.episode;
    }
  }

  // If episode is still missing for an episode item, check badge text (e.g. "Episode-01")
  if (isEpisode && episode === null && itemContainer.length) {
    const badgeText = itemContainer.find('.badge-psa, [class*="badge"]').text();
    const epMatch = badgeText.match(/Episode[-_\s]*(\d+)/i);
    if (epMatch) {
      episode = parseInt(epMatch[1], 10);
    }
  }

  return {
    filename,
    scope,
    quality: quality || 'unknown',
    season,
    episode,
    language: language || null,
  };
}
