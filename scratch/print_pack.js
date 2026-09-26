import * as cheerio from 'cheerio';
import fs from 'fs';

const html = fs.readFileSync('scratch/reacher.html', 'utf-8');
const $ = cheerio.load(html);

const packItem = $('#complete-pack .season-item, #complete-pack [class*="item"], #complete-pack .download-item').first();
console.log('--- RAW HTML OF #complete-pack item ---');
console.log(packItem.html());
