import {
  extractQuality,
  extractCodec,
  extractAudio,
  extractYear,
  extractSeason,
  extractEpisode,
  extractLanguages,
} from '../sources/source-parser.js';

/**
 * Extracts release source (e.g. WEB-DL, BluRay, HDTV, DVDRip, REMUX).
 */
export function extractSource(filename) {
  if (!filename) return null;
  const match = filename.match(/\b(web-?dl|webrip|bluray|bdrip|remux|hdtv|dvdrip)\b/i);
  if (!match) return null;
  const upper = match[1].toUpperCase();
  if (upper === 'WEBDL' || upper === 'WEB-DL') return 'WEB-DL';
  if (upper === 'WEBRIP') return 'WEBRip';
  if (upper === 'BLURAY') return 'BluRay';
  return upper;
}

/**
 * Extracts file extension (format).
 */
export function extractExtension(filename) {
  if (!filename) return null;
  const match = filename.trim().match(/\.([a-zA-Z0-9]{2,5})$/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Cleans filename to isolate the media title.
 */
export function extractCleanTitle(filename) {
  if (!filename) return null;

  // Remove extension
  let name = filename.replace(/\.[a-zA-Z0-9]{2,5}$/, '');

  // Replace dots, underscores with spaces
  name = name.replace(/[._]/g, ' ');

  // Cut off at first occurrence of season, year, or quality
  const cutoffMatch = name.search(/\b(?:s\d{1,2}|19\d{2}|20\d{2}|2160p|1080p|720p|480p|web-?dl|bluray)\b/i);
  if (cutoffMatch > 0) {
    name = name.substring(0, cutoffMatch);
  }

  // Clean trailing punctuation and whitespace
  name = name.replace(/[-–—()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return name.length > 0 ? name : null;
}

/**
 * Parses structured metadata from a filename or release string.
 * Unknown fields return null rather than guessed values.
 * 
 * @param {string} filename
 * @returns {object}
 */
export function parseFilenameMetadata(filename) {
  if (!filename || typeof filename !== 'string') {
    return {
      title: null,
      year: null,
      season: null,
      episode: null,
      quality: null,
      source: null,
      codec: null,
      audio: [],
      languages: [],
      extension: null,
    };
  }

  const extension = extractExtension(filename);
  const title = extractCleanTitle(filename);
  const year = extractYear(filename);
  const season = extractSeason(filename);
  const episode = extractEpisode(filename);
  const quality = extractQuality(filename);
  const source = extractSource(filename);
  const codec = extractCodec(filename);
  const audio = extractAudio(filename);
  const languages = extractLanguages(filename);

  return {
    title,
    year,
    season,
    episode,
    quality,
    source,
    codec,
    audio,
    languages,
    extension,
  };
}

export default parseFilenameMetadata;
