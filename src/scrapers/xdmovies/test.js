/**
 * Smoke test for XDMovies Scraper & Resolver
 * Run with: node src/scrapers/xdmovies/test.js [url] [--catalogue-only]
 */

import { resolveXDMovies } from './resolver.js';

const args = process.argv.slice(2);
const catalogueOnly = args.includes('--catalogue-only');
const nonFlagArgs = args.filter((a) => !a.startsWith('--'));

const TEST_URL =
  nonFlagArgs[0] ||
  'https://huh.xdmovies.wtf/series/fading-grandeur-1080p-720p-hindi-spanish-download-335535';

console.log(`\n========================================`);
console.log(`🎬  Testing XDMovies Resolver`);
console.log(`    Target: ${TEST_URL}`);
console.log(`    Resolve Destination: ${!catalogueOnly}`);
console.log(`========================================\n`);

async function run() {
  const result = await resolveXDMovies(TEST_URL, {
    headless: false,
    resolveDestination: !catalogueOnly,
  });

  console.log('\n--- RESOLUTION RESULT ---');
  console.log('Success     :', result.success);
  console.log('State       :', result.state);
  console.log('Title       :', result.title);
  console.log('Provider    :', result.provider);
  console.log('Destination :', result.destination);
  console.log('Mediator URL:', result.mediatorUrl);
  console.log('Metadata    :', result.metadata);
  console.log('Elapsed (ms):', result.elapsedMs);

  if (result.error) {
    console.error('❌ Error:', result.error);
    process.exit(1);
  }

  const cat = result.catalogue;
  if (cat) {
    console.log('\n--- CATALOGUE DETAILS ---');
    console.log(`Title         : ${cat.title}`);
    console.log(`Year          : ${cat.year ?? 'unknown'}`);
    console.log(`Total Releases: ${cat.totalReleases}`);
    console.log(`Total Links   : ${cat.totalLinks}`);

    console.log('\n📦  Qualities Breakdown:');
    for (const q of cat.qualities) {
      console.log(`  [${q.resolution}] — ${q.releases.length} item(s)`);
      for (const rel of q.releases.slice(0, 3)) {
        console.log(`    • ${rel.label} (${rel.scope}) — ${rel.downloadLinks.length} link(s)`);
        for (const dl of rel.downloadLinks) {
          console.log(`        [${dl.provider}] ${dl.label} -> ${dl.url}`);
        }
      }
      if (q.releases.length > 3) {
        console.log(`      ... and ${q.releases.length - 3} more releases`);
      }
    }

    if (cat.seasons && cat.seasons.length > 0) {
      console.log('\n📺  Seasons Breakdown:');
      for (const s of cat.seasons) {
        console.log(`  Season ${s.number} — ${s.releases.length} release(s)`);
      }
    }
  }

  console.log('\n✅  XDMovies resolution completed successfully!\n');
}

run();
