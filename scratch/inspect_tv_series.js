import { fetchWithControls } from '../src/discovery/http-client.js';
import * as cheerio from 'cheerio';
import fs from 'fs';

async function main() {
  const url = 'https://4khdhub.one/reacher-series-655/';
  console.log('Fetching', url);
  const res = await fetchWithControls(url);
  if (!res.success) {
    console.log('Error:', res.error);
    return;
  }
  fs.writeFileSync('scratch/reacher.html', res.body, 'utf-8');
  console.log('Saved reacher.html. Length:', res.body.length);

  const $ = cheerio.load(res.body);
  console.log('Title:', $('title').text());
  
  // Look for Zip/Pack and Single EP tabs, accordions, episodes, links
  console.log('\n--- HEADINGS & ACCORDIONS ---');
  $(':header, .season, [class*="season"], [class*="episode"], [id*="season"], [id*="episode"]').slice(0, 30).each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (text) console.log($(el).prop('tagName'), '|', $(el).attr('class') || '', '|', text.slice(0, 80));
  });

  console.log('\n--- A[HREF] BUTTONS / DOWNLOAD LINKS ---');
  let hubcloudCount = 0;
  $('a[href]').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    const href = $(el).attr('href') || '';
    if (/hubcloud|greenmotors|fast-share|fastdl|download/i.test(text) || /greenmotors|hubcloud|fast-share/i.test(href)) {
      hubcloudCount++;
      if (hubcloudCount <= 20) {
        console.log(`[${hubcloudCount}] text="${text}" href="${href.slice(0, 80)}"`);
      }
    }
  });
  console.log('Total HubCloud / download links found:', hubcloudCount);
}

main().catch(console.error);
