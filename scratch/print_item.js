import * as cheerio from 'cheerio';
import fs from 'fs';

const html = fs.readFileSync('scratch/reacher.html', 'utf-8');
const $ = cheerio.load(html);

const item = $('#episodes .episode-download-item').first();
console.log('--- RAW HTML OF .episode-download-item ---');
console.log(item.html());
