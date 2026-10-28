import * as cheerio from 'cheerio';
import {
  extractPageTitle,
  decodeFilePayload,
  detectQuality,
  detectCodec,
  detectSeasonEpisode,
  detectContentTypeFromUrl,
  extractButtonSize,
} from './parser.js';

/**
 * Extracts download releases and decoded provider URLs from CloudMoviez HTML.
 * Supports both Movies (/movies/) and TV Series (/tvshows/).
 * 
 * @param {string} html - Raw HTML of CloudMoviez page
 * @param {string} [sourceUrl] - Original source URL
 * @param {object} [options] - Quality and scope filter options
 * @returns {{
 *   title: string,
 *   sourceUrl: string,
 *   contentType: 'movie'|'series'|'unknown',
 *   links: Array<object>,
 *   allLinks: Array<object>
 * }}
 */
export function extractCloudMoviezLinks(html, sourceUrl = '', options = {}) {
  if (!html || typeof html !== 'string') {
    return { title: 'Unknown Title', sourceUrl, contentType: 'unknown', links: [], allLinks: [] };
  }

  const $ = cheerio.load(html);
  const canonicalUrl = $('link[rel="canonical"]').attr('href');
  if (canonicalUrl && (!sourceUrl || sourceUrl.includes('jpg') || sourceUrl === 'https://c1.cloudmoviez.shop/')) {
    sourceUrl = canonicalUrl;
  }

  const title = extractPageTitle($);
  let contentType = detectContentTypeFromUrl(sourceUrl) || 'unknown';
  if (contentType === 'unknown') {
    if (/\/tvshows?\//i.test(sourceUrl) || $('#single[itemtype*="TVSeries"]').length > 0 || /\[Season\s*\d+\]/i.test(title)) {
      contentType = 'series';
    } else if (/\/movies?\//i.test(sourceUrl)) {
      contentType = 'movie';
    }
  }

  const genres = [];
  $('.sgeneros a').each((_, g) => {
    const t = $(g).text().trim();
    if (t && !/^\d+p$/i.test(t) && !/^4k$/i.test(t) && !/ddp|dd5|audio/i.test(t)) {
      genres.push(t);
    }
  });
  const genreStr = [...new Set(genres)].slice(0, 3).join(', ');

  const allLinks = [];
  const seenUrls = new Set();

  // Each release is represented by a .cmz-row-card inside a .cmz-accordion
  const rowCards = $('.cmz-row-card');

  rowCards.each((_, rowEl) => {
    const $row = $(rowEl);
    const rowTitle = $row.find('.cmz-row-title').text().trim();
    if (!rowTitle) return;

    // Parent accordion information
    const $accordion = $row.closest('.cmz-accordion');
    const accordionTitle = $accordion.find('.cmz-accordion-title').text().trim();
    const accordionTags = $accordion.find('.cmz-accordion-tags').text().trim();

    // Determine quality and codec
    const quality = detectQuality(rowTitle) || detectQuality(accordionTitle) || '1080p';
    const codec = detectCodec(rowTitle) || detectCodec(accordionTitle) || 'H.264';

    // Determine season, episode, and scope
    let season = null;
    let episode = null;
    let scope = 'movie';

    if (contentType === 'series' || (!contentType && (/\/tvshows?\//i.test(sourceUrl) || /\b(?:s\d{1,2}|season|episodes?)\b/i.test(accordionTitle)))) {
      contentType = 'series';
      const se = detectSeasonEpisode(`${accordionTitle} ${rowTitle}`);
      season = se.season;
      episode = se.episode;

      if (episode !== null) {
        scope = 'episode';
      } else if (/\b(pack|complete|zip|batch|all\s*episodes?)\b/i.test(`${accordionTitle} ${rowTitle}`)) {
        scope = 'pack';
      } else {
        scope = 'pack';
      }
    } else {
      contentType = 'movie';
      scope = 'movie';
    }

    // Inspect buttons in this row
    // Priority: GDFLIX (.cmz-btn-gdflix) as primary provider link
    const gdflixBtn = $row.find('a.cmz-btn-gdflix');
    const dotflixBtn = $row.find('a.cmz-btn-dotflix');
    const allBtns = $row.find('a.cmz-download-btn, .cmz-btn-group a');

    // Extract preferred button (GDFLIX first, then fallback to first button)
    let targetBtn = gdflixBtn.length > 0 ? gdflixBtn.first() : (dotflixBtn.length > 0 ? dotflixBtn.first() : allBtns.first());

    if (targetBtn.length > 0) {
      const rawHref = targetBtn.attr('href') || '';
      const payload = decodeFilePayload(rawHref);
      const directProviderUrl = payload?.url || (rawHref && /^https?:\/\//i.test(rawHref) && !rawHref.includes('?file=') ? rawHref : null);

      if (directProviderUrl) {
        if (!seenUrls.has(directProviderUrl)) {
          seenUrls.add(directProviderUrl);

          const sizeDisplay = extractButtonSize(targetBtn, $) || null;
          let providerName = (payload?.title || '').toUpperCase();
          if (!providerName) {
            if (/gdflix/i.test(directProviderUrl)) providerName = 'GDFLIX';
            else if (/hubcloud/i.test(directProviderUrl)) providerName = 'HUBCLOUD';
            else providerName = 'GDFLIX';
          }

          allLinks.push({
            title: rowTitle,
            filename: rowTitle,
            scope,
            season,
            episode,
            quality,
            codec,
            sizeDisplay,
            provider: providerName,
            providerUrl: directProviderUrl,
            mediatorUrl: rawHref,
            sourceUrl: sourceUrl || 'https://c1.cloudmoviez.shop/',
            status: 'RESOLVED',
          });
        }
      }
    }
  });

  // Fallback: If no .cmz-row-card elements exist, extract from tables or classic WordPress download link blocks
  if (allLinks.length === 0) {
    // Check table rows first
    $('tr').each((_, tr) => {
      const $tr = $(tr);
      const link = $tr.find('a[href*="/links/"]').first();
      if (!link.length) return;
      const href = link.attr('href');
      if (!href || seenUrls.has(href)) return;
      seenUrls.add(href);

      const tds = $tr.find('td, th').map((_, td) => $(td).text().trim()).get();
      // Format usually: [ 'Download', '480p x264', 'Hindi DD5.1', '1.03 GB' ]
      const qualStr = tds[1] || '';
      const sizeStr = tds[3] || '';

      const quality = detectQuality(qualStr) || detectQuality(title) || '1080p';
      const codec = detectCodec(qualStr) || detectCodec(title) || 'H.264';
      const sizeDisplay = sizeStr || null;

      let currentScope = contentType === 'series' ? 'pack' : 'movie';
      const epMatch = sourceUrl.match(/(\d+)x(\d+|all)/i);
      let season = null;
      let episode = null;
      if (epMatch) {
        season = parseInt(epMatch[1], 10);
        if (epMatch[2].toLowerCase() === 'all') {
          currentScope = 'pack';
          episode = null;
        } else {
          currentScope = 'episode';
          episode = parseInt(epMatch[2], 10);
        }
      } else if (contentType === 'series') {
        const se = detectSeasonEpisode(title);
        season = se.season || 1;
        episode = se.episode;
      } else {
        currentScope = 'movie';
        season = null;
        episode = null;
      }

      const cleanTitle = title.replace(/\[Season\s*\d+\]/i, '').replace(/\s*–\s*CloudMoviez.*$/i, '').trim();
      const ext = currentScope === 'pack' ? '.zip' : '.mkv';
      const epTag = episode ? `E${String(episode).padStart(2, '0')}.` : '';
      const seasonTag = season ? `S${String(season).padStart(2, '0')}.` : '';
      const filename = `${cleanTitle.replace(/\s+/g, '.')}.${seasonTag}${epTag}${quality}.${codec}${sizeDisplay ? '.' + sizeDisplay.replace(/\s+/g, '') : ''}${ext}`;

      const titleDisplay = (currentScope === 'movie')
        ? `${cleanTitle} ${quality} [${sizeDisplay || ''}]`
        : `${cleanTitle} S${String(season || 1).padStart(2, '0')}${episode ? 'E' + String(episode).padStart(2, '0') : ' Complete'} ${quality} [${sizeDisplay || ''}]`;

      allLinks.push({
        title: titleDisplay,
        filename,
        scope: currentScope,
        season,
        episode,
        quality,
        codec,
        sizeDisplay,
        provider: 'GDFLIX',
        providerUrl: href,
        mediatorUrl: href,
        sourceUrl: sourceUrl || 'https://c1.cloudmoviez.shop/',
        status: 'RESOLVED',
      });
    });

    const rawLinks = $('#info a[href*="/links/"], .wp-content a[href*="/links/"], a[href*="/links/"]');
    let currentScope = contentType === 'series' ? 'pack' : 'movie';

    rawLinks.each((_, el) => {
      const $a = $(el);
      const href = $a.attr('href');
      if (!href) return;
      const text = $a.text().replace(/\s+/g, ' ').trim();
      if (!text) return;

      const prevP = $a.closest('h3').prevAll('p').text();
      if (/single episodes/i.test(prevP)) {
        currentScope = 'episode';
      }

      const quality = detectQuality(text) || '1080p';
      const codec = detectCodec(text) || 'H.264';
      const sizeMatch = text.match(/\[([0-9.]+\s*[GMB]+)\]/i);
      const sizeDisplay = sizeMatch ? sizeMatch[1].toUpperCase() : null;

      const cleanTitle = title.replace(/\[Season\s*\d+\]/i, '').trim();
      const se = detectSeasonEpisode(title);
      const isMovie = contentType === 'movie' || currentScope === 'movie';
      const season = isMovie ? null : (se.season || 1);
      const episode = isMovie ? null : se.episode;

      const ext = currentScope === 'pack' ? '.zip' : '.mkv';
      const seasonTag = season ? `S${String(season).padStart(2, '0')}.` : '';
      const filename = `${cleanTitle.replace(/\s+/g, '.')}.${seasonTag}${quality}.${codec}${sizeDisplay ? '.' + sizeDisplay.replace(/\s+/g, '') : ''}${ext}`;

      if (!seenUrls.has(href)) {
        seenUrls.add(href);
        allLinks.push({
          title: isMovie ? `${cleanTitle} ${text}` : `${cleanTitle} ${season ? 'S0' + season + ' ' : ''}${text}`,
          filename,
          scope: currentScope,
          season,
          episode,
          quality,
          codec,
          sizeDisplay,
          provider: 'GDFLIX',
          providerUrl: href,
          mediatorUrl: href,
          sourceUrl: sourceUrl || 'https://c1.cloudmoviez.shop/',
          status: 'RESOLVED',
        });
      }
    });
  }

  // Filter links based on targetQuality and targetScope if specified
  let filteredLinks = [...allLinks];
  if (options.targetQuality && options.targetQuality !== 'all') {
    const q = options.targetQuality.toLowerCase().replace(/p$/, '');
    const matched = filteredLinks.filter((l) => (l.quality || '').toLowerCase().replace(/p$/, '') === q);
    if (matched.length > 0) filteredLinks = matched;
  }
  if (options.targetScope && options.targetScope !== 'all') {
    const matched = filteredLinks.filter((l) => l.scope === options.targetScope);
    if (matched.length > 0) filteredLinks = matched;
  }

  return {
    title,
    cleanTitle: title.replace(/\[Season\s*\d+\]/i, '').replace(/\{[^}]+\}/g, '').trim(),
    sourceUrl,
    contentType,
    genre: genreStr,
    links: filteredLinks,
    allLinks,
  };
}

export default {
  extractCloudMoviezLinks,
};
