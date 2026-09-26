import * as cheerio from 'cheerio';
import fs from 'fs';

const html = fs.readFileSync('scratch/xdmovies_sample.html', 'utf8');
const $ = cheerio.load(html);

const title = $('h2').first().text().trim() || $('title').text().replace(/—.*$/, '').trim();
console.log('Title:', title);

const packs = [];
$('.pack-card').each((_, el) => {
  const filename = $(el).find('.pack-title').text().trim();
  const link = $(el).find('a[href*="/download/"]').attr('href');
  const size = $(el).find('.size-badge').text().trim();
  packs.push({ filename, link, size, scope: 'pack' });
});

const episodes = [];
$('.episode-card').each((_, el) => {
  const filename = $(el).find('.episode-title').text().trim();
  const link = $(el).find('a[href*="/download/"]').attr('href');
  const size = $(el).find('.movie-download-btn').text().trim();
  const codec = $(el).find('.codec-badge').text().trim();
  episodes.push({ filename, link, size, codec, scope: 'episode' });
});

console.log('Packs extracted count:', packs.length);
console.log('Packs:', packs);
console.log('Episodes extracted count:', episodes.length);
console.log('Episodes:', episodes);
