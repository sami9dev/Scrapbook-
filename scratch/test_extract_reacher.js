import { extract4KHDHubLinks } from '../src/providers/4khdhub/extractor.js';
import fs from 'fs';

const html = fs.readFileSync('scratch/reacher.html', 'utf-8');
const result = extract4KHDHubLinks(html, 'https://4khdhub.one/reacher-series-655/');

console.log('Title:', result.title);
console.log('Total extracted links:', result.links.length);

const sample = result.links.slice(0, 10);
for (const l of sample) {
  console.log({
    filename: l.filename,
    season: l.season,
    episode: l.episode,
    quality: l.quality,
    mediatorUrl: l.mediatorUrl?.slice(0, 50),
  });
}
