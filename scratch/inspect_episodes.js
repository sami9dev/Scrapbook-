import * as cheerio from 'cheerio';
import fs from 'fs';

const html = fs.readFileSync('scratch/reacher.html', 'utf-8');
const $ = cheerio.load(html);

console.log('--- #episodes INSIDE ---');
const epContainer = $('#episodes');
console.log('episodes container found:', epContainer.length);

// Check seasons inside #episodes
epContainer.find('.season-item, .season-accordion, [class*="season"]').slice(0, 15).each((i, el) => {
  console.log(`SEASON ITEM ${i}:`, $(el).prop('tagName'), '| class:', $(el).attr('class') || '', '| text:', $(el).clone().children().remove().end().text().trim() || $(el).children().first().text().trim().replace(/\s+/g, ' ').slice(0, 80));
});

// Check download buttons inside #episodes
const epLinks = epContainer.find('a[href]');
console.log('Total a[href] in #episodes:', epLinks.length);
epLinks.slice(0, 10).each((i, el) => {
  const $el = $(el);
  const text = $el.text().trim().replace(/\s+/g, ' ');
  const href = $el.attr('href') || '';
  const parent = $el.closest('[class*="episode"], [class*="item"], tr, div').text().trim().replace(/\s+/g, ' ');
  console.log(`EP LINK ${i}: text="${text}" href="${href.slice(0, 50)}" | context="${parent.slice(0, 80)}"`);
});

console.log('\n--- #complete-pack INSIDE ---');
const packContainer = $('#complete-pack');
console.log('pack container found:', packContainer.length);
const packLinks = packContainer.find('a[href]');
console.log('Total a[href] in #complete-pack:', packLinks.length);
packLinks.slice(0, 10).each((i, el) => {
  const $el = $(el);
  const text = $el.text().trim().replace(/\s+/g, ' ');
  const href = $el.attr('href') || '';
  const parent = $el.closest('[class*="season"], tr, div').text().trim().replace(/\s+/g, ' ');
  console.log(`PACK LINK ${i}: text="${text}" href="${href.slice(0, 50)}" | context="${parent.slice(0, 80)}"`);
});
