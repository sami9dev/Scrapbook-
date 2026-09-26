import * as cheerio from 'cheerio';
import fs from 'fs';
import { HUBCLOUD_BUTTON_PATTERNS } from '../src/providers/4khdhub/selectors.js';
import { detectQualityFromText, detectSeasonEpisodeFromText } from '../src/providers/4khdhub/parser.js';

const html = fs.readFileSync('scratch/reacher.html', 'utf-8');
const $ = cheerio.load(html);

const links = [];
const seenUrls = new Set();

$('a[href]').each((_, el) => {
  const $el = $(el);
  const href = ($el.attr('href') || '').trim();
  if (!href || href === '#' || href.startsWith('javascript:')) return;

  const combinedText = `${$el.text().trim()} ${$el.attr('aria-label') || ''} ${$el.attr('title') || ''}`.trim();
  const isHubCloudButton = HUBCLOUD_BUTTON_PATTERNS.some((p) => p.test(combinedText));
  if (!isHubCloudButton) return;

  if (seenUrls.has(href)) return;
  seenUrls.add(href);

  // Determine scope: 'episode' vs 'pack'
  const isEpisode = $el.closest('#episodes, .episode-download-item, .episode-item, .episode-links').length > 0;
  const isPack = $el.closest('#complete-pack, [data-file-id], [id*="content-file"]').length > 0;
  const scope = isEpisode ? 'episode' : (isPack ? 'pack' : 'movie');

  // Find container
  const container = $el.closest('.episode-download-item, .download-item, [id^="content-"], .episode-item, .season-item');
  let filename = container.find('.episode-file-title, .file-title').first().text().trim() || null;

  let quality = filename ? detectQualityFromText(filename) : null;
  if (!quality) {
    const contextText = container.text().trim() + ' ' + $el.closest('.season-content, .season-item, .episode-item').text().trim();
    quality = detectQualityFromText(contextText) || 'unknown';
  }

  let season = null;
  let episode = null;
  if (filename) {
    const se = detectSeasonEpisodeFromText(filename);
    season = se.season;
    episode = se.episode;
  }
  if (season === null) {
    const parentHeader = $el.closest('.season-item, .episode-item').find('.episode-number, .download-header, h3').text();
    const se = detectSeasonEpisodeFromText(parentHeader);
    season = se.season;
  }
  if (isEpisode && episode === null) {
    const badgeText = container.find('.badge-psa, [class*="badge"]').text();
    const epMatch = badgeText.match(/Episode[-_\s]*(\d+)/i);
    if (epMatch) {
      episode = parseInt(epMatch[1], 10);
    }
  }

  links.push({
    scope,
    filename: filename || 'Reacher',
    season,
    episode,
    quality,
    mediatorUrl: href.slice(0, 45) + '...',
  });
});

console.log('Total HubCloud links parsed:', links.length);
const episodeLinks = links.filter(l => l.scope === 'episode');
const packLinks = links.filter(l => l.scope === 'pack');

console.log(`Packs: ${packLinks.length} | Episodes: ${episodeLinks.length}`);

console.log('\n--- SAMPLE PACKS ---');
console.log(packLinks.slice(0, 3));

console.log('\n--- SAMPLE EPISODES ---');
console.log(episodeLinks.slice(0, 5));
