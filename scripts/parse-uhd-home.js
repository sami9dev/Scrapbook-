import fs from 'fs';
import * as cheerio from 'cheerio';

const html = fs.readFileSync('src/data/uhdmovies-home.html', 'utf8');
const $ = cheerio.load(html);

const posts = [];
$('article').each((_, el) => {
  const a = $(el).find('a').first();
  const href = a.attr('href') || '';
  const title = $(el).find('h2, h3, .entry-title').text().trim() || a.attr('title') || '';
  if (href && title) {
    const isSeries = /season|series|s\d+|episode|episodes/i.test(title) || /tvshows|series/i.test(href);
    const cleanTitle = title
      .replace(/^Download\s+/i, '')
      .replace(/\s*\(?(?:19|20)\d{2}\)?.*$/i, '')
      .trim();
    const yearMatch = title.match(/\b(19\d{2}|20\d{2})\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

    posts.push({
      title: cleanTitle || title,
      fullTitle: title,
      url: href,
      format: isSeries ? 'Series' : 'Movie',
      year,
    });
  }
});

console.log('Total articles found:', posts.length);
posts.forEach((p, i) => {
  console.log(`${i + 1}. [${p.format}] ${p.title} (${p.year || 'N/A'}) -> ${p.url}`);
});
