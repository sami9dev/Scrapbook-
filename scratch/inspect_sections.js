import * as cheerio from 'cheerio';
import fs from 'fs';

const html = fs.readFileSync('scratch/reacher.html', 'utf-8');
const $ = cheerio.load(html);

console.log('--- SECTION HEADINGS ---');
$('h2, h3, .section-title, .series-tabs, .tab-btn').each((_, el) => {
  console.log($(el).prop('tagName'), '| class:', $(el).attr('class') || '', '| id:', $(el).attr('id') || '', '| text:', $(el).text().trim().replace(/\s+/g, ' ').slice(0, 100));
});

console.log('\n--- TABS / CONTAINERS ---');
$('[class*="tab"], [id*="tab"]').each((_, el) => {
  const cls = $(el).attr('class') || '';
  const id = $(el).attr('id') || '';
  if (cls.includes('tab') || id.includes('tab')) {
    console.log($(el).prop('tagName'), '| id:', id, '| class:', cls, '| data:', $(el).data());
  }
});
