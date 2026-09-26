import * as cheerio from 'cheerio';
import type { ProviderMetadata, ProviderLink } from '../../types.js';
import { XDMOVIES_META_SELECTORS } from './selectors.js';

async function getExtractor(): Promise<(html: string, sourceUrl: string, opts?: Record<string,string>) => { title: string; type: string; audios: string[]; ottSource: string|null; links: Array<{title:string;filename:string;scope:string;season:number|null;episode:number|null;quality:string;codec:string|null;sizeDisplay:string|null;redirectUrl:string;provider:string;sourceUrl:string}>; allLinks: any[] }> {
  const mod = await import('../../../providers/xdmovies/extractor.js');
  return mod.extractXDMoviesLinks;
}

export function parseXDMoviesMetadata(html: string, sourceUrl: string): ProviderMetadata {
  const $ = cheerio.load(html);
  let title = '';
  for (const sel of XDMOVIES_META_SELECTORS.title) {
    const t = $(sel).first().text().trim();
    if (t) { title = t; break; }
  }
  let poster: string|null = null;
  for (const sel of XDMOVIES_META_SELECTORS.poster) {
    const src = $(sel).first().attr('src');
    if (src) { poster = src; break; }
  }
  let description: string|null = null;
  for (const sel of XDMOVIES_META_SELECTORS.description) {
    const d = $(sel).first().text().trim();
    if (d && d.length > 20) { description = d; break; }
  }
  const genres: string[] = [];
  for (const sel of XDMOVIES_META_SELECTORS.genres) {
    $(sel).each((_, el) => { const g=$(el).text().trim(); if(g) genres.push(g); });
    if (genres.length) break;
  }
  let releaseDate: string|null = null;
  for (const sel of XDMOVIES_META_SELECTORS.releaseDate) {
    const d = $(sel).attr('datetime') || $(sel).text().trim();
    if (d) { releaseDate = d; break; }
  }
  const isTv = /\/series\//i.test(sourceUrl) || /season|episode|s\d+e\d+/i.test(title);
  const audioMatches = title.match(/\b(Hindi|English|Tamil|Telugu|Bengali|Multi)\b/gi);
  const language = audioMatches ? [...new Set(audioMatches.map(l=>l.trim()))] : [];
  let quality = 'unknown';
  if (/2160p|4k|uhd/i.test(title)) quality = '2160p';
  else if (/1080p|fhd/i.test(title)) quality = '1080p';
  else if (/720p/i.test(title)) quality = '720p';
  else if (/480p/i.test(title)) quality = '480p';
  const hdrMatch = title.match(/\b(HDR10\+?|Dolby\s*Vision|DV|HDR)\b/i);
  let codec: string|null = null;
  if (/h\.?265|hevc/i.test(title)) codec = 'H.265';
  else if (/h\.?264|avc/i.test(title)) codec = 'H.264';
  const audioMatch = title.match(/\b(TrueHD|DDP|Atmos|DTS|AAC|AC3|EAC3)\s*[\d.]+/i);
  return {
    title, type: isTv ? 'tv' : 'movie', language, genres, description, releaseDate, poster,
    quality, hdr: hdrMatch?.[0] ?? null, codec, audio: audioMatch?.[0] ?? null,
    providerUrl: sourceUrl, rawTitle: title,
  };
}

export async function parseXDMoviesLinks(
  html: string, sourceUrl: string,
  options: { targetQuality?: string; targetScope?: 'movie'|'pack'|'episode' } = {},
): Promise<ProviderLink[]> {
  const extractXDMoviesLinks = await getExtractor();
  const result = extractXDMoviesLinks(html, sourceUrl, options as any);
  return result.links.map((link, i) => ({
    id: `xdm-${i}-${Buffer.from(link.redirectUrl).toString('base64').slice(0,8)}`,
    title: link.title, filename: link.filename, quality: link.quality, codec: link.codec,
    language: result.audios.join(', ') || null, season: link.season, episode: link.episode,
    scope: (link.scope as 'movie'|'pack'|'episode') ?? 'movie',
    sizeDisplay: link.sizeDisplay, redirectUrl: link.redirectUrl,
    provider: 'xdmovies' as const, sourceUrl,
  }));
}
