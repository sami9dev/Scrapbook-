import * as cheerio from 'cheerio';
import fs from 'fs';

const html = fs.readFileSync('scratch/reacher.html', 'utf-8');
const $ = cheerio.load(html);

const firstEpisodeItem = $('#episodes .episode-item').first();
console.log('--- FIRST EPISODE ITEM HEADER ---');
console.log(firstEpisodeItem.find('.episode-header').text().trim().replace(/\s+/g, ' '));

console.log('--- FIRST EPISODE ITEM LINKS/ROWS ---');
firstEpisodeItem.find('a[href]').each((i, el) => {
  const $a = $(el);
  const text = $a.text().trim().replace(/\s+/g, ' ');
  const href = $a.attr('href') || '';
  const row = $a.closest('div, li, p, tr').text().trim().replace(/\s+/g, ' ');
  console.log(`LINK ${i}: text="${text}" href="${href.slice(0, 60)}" row="${row.slice(0, 100)}"`);
});

console.log('\n--- FIRST EPISODE ITEM FULL HTML (first 1500 chars) ---');
console.log(firstEpisodeItem.html().slice(0, 1500));
