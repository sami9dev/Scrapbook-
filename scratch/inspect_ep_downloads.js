import * as cheerio from 'cheerio';
import fs from 'fs';

const html = fs.readFileSync('scratch/reacher.html', 'utf-8');
const $ = cheerio.load(html);

const epDownloads = $('#content-14443 .episode-downloads');
console.log('Total items in #content-14443:', epDownloads.find('.episode-download-item').length);
epDownloads.find('.episode-download-item').each((i, el) => {
  const title = $(el).find('.file-title, .title, strong, b, h4, h5, p, span').first().text().trim() || $(el).text().trim().replace(/\s+/g, ' ');
  const links = $(el).find('a[href]').map((_, a) => `${$(a).text().trim()} -> ${$(a).attr('href')}`).get().join(' | ');
  console.log(`EPISODE ${i+1}: title="${title.slice(0, 80)}" | ${links}`);
});
