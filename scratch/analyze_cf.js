import * as cheerio from 'cheerio';
import fs from 'fs';

const html = fs.readFileSync('scratch/cf_frame.html', 'utf8');
const $ = cheerio.load(html);

console.log('Inputs:', $('input').map((_, el) => `${$(el).attr('type')} id=${$(el).attr('id')} name=${$(el).attr('name')}`).get());
console.log('Buttons:', $('button').map((_, el) => $(el).attr('id') || $(el).text()).get());
console.log('Labels:', $('label').map((_, el) => $(el).attr('class') || $(el).text()).get());
console.log('Body Text snippet:', $('body').text().trim().replace(/\s+/g, ' ').slice(0, 300));
