import * as cheerio from 'cheerio';
import fs from 'fs';

const html = fs.readFileSync('scratch/reacher.html', 'utf-8');
const $ = cheerio.load(html);

console.log('Testing improved DOM selector...');

$('#episodes a[href]').slice(0, 10).each((i, el) => {
  const $el = $(el);
  const container = $el.closest('.episode-download-item, .download-item, [id^="content-"], .episode-item');
  const fileTitle = container.find('.episode-file-title, .file-title').first().text().trim();
  const badgeEpisode = container.find('.badge-psa, [class*="episode"]').first().text().trim();
  console.log(`EP ${i}: fileTitle="${fileTitle}" | badge="${badgeEpisode}"`);
});

$('#complete-pack a[href]').slice(0, 5).each((i, el) => {
  const $el = $(el);
  const container = $el.closest('.season-item, [id^="content-"], .download-item');
  const fileTitle = container.find('.file-title, .episode-file-title').first().text().trim();
  console.log(`PACK ${i}: fileTitle="${fileTitle}"`);
});
