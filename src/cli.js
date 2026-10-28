#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseSourcePage } from './sources/source-parser.js';
import { fetchWithControls } from './discovery/http-client.js';
import { discoverExposedDestination } from './discovery/link-discovery.js';
import { providerRegistry } from './providers/provider-registry.js';
import './providers/gdflix.js';
import './providers/vcloud.js';

function decodeFileToken(url) {
  if (!url) return null;
  const match = url.match(/[?&]file=([a-zA-Z0-9+/=]+)/);
  if (!match) return null;
  try {
    const raw = Buffer.from(match[1], 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    return parsed.url || null;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  node src/cli.js <URL | HTML_FILE_PATH> [--quality 2160p|1080p|720p|480p|all]

Examples:
  node src/cli.js https://c1.cloudmoviez.shop/tvshows/from/ --quality 2160p
  node src/cli.js ./saved-page.html --quality 1080p
`);
    process.exit(0);
  }

  let target = args[0];
  let qualityFilter = 'all';

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--quality' && args[i + 1]) {
      qualityFilter = args[i + 1].toLowerCase().replace(/p$/, '');
      i++;
    }
  }

  let html = '';
  let sourceUrl = 'https://localhost/';

  if (target.startsWith('http://') || target.startsWith('https://')) {
    sourceUrl = target;
    console.error(`[INFO] Fetching source URL: ${sourceUrl}...`);
    const res = await fetchWithControls(sourceUrl);
    if (!res.success) {
      console.error(`[ERROR] Failed to fetch source page (${res.status}): ${res.error}`);
      process.exit(1);
    }
    html = res.body;
  } else {
    const resolvedPath = path.resolve(process.cwd(), target);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`[ERROR] File not found: ${resolvedPath}`);
      process.exit(1);
    }
    console.error(`[INFO] Reading local HTML file: ${resolvedPath}...`);
    html = fs.readFileSync(resolvedPath, 'utf8');
    sourceUrl = 'https://source-archive.local/';
  }

  const parsed = parseSourcePage(html, sourceUrl);
  let discovered = parsed.discoveredLinks;

  if (qualityFilter !== 'all') {
    const filtered = discovered.filter((l) => {
      if (!l.quality) return false;
      return l.quality.toLowerCase().replace(/p$/, '') === qualityFilter;
    });
    if (filtered.length > 0) {
      discovered = filtered;
    }
  }

  console.error(`[INFO] Found ${discovered.length} links (Quality filter: ${qualityFilter}):\n`);

  for (const item of discovered) {
    const filename = item.filename || item.rowTitle || parsed.title || 'Unknown-File';
    let destUrl = decodeFileToken(item.resolvedUrl) || item.resolvedUrl;
    let providerName = 'LINK';

    if (item.provider) {
      providerName = item.provider;
    } else {
      const matched = providerRegistry.findProvider(destUrl);
      if (matched) {
        providerName = matched.name;
      } else if (destUrl.includes('gdflix') || destUrl.includes('dotflix') || destUrl.includes('dtflix')) {
        providerName = 'GDFLIX';
      } else if (destUrl.includes('hubcloud')) {
        providerName = 'HUBCLOUD';
      }
    }

    console.log(`Name : ${filename} ${providerName} = ${destUrl}`);
  }
}

main().catch((err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
