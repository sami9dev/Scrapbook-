import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const API_BASE = process.env.API_BASE_URL || 'https://scrapbook-0mrx.onrender.com';
const BATCH_ENDPOINT = `${API_BASE}/api/links/batch`;

/**
 * Normalizes quality string from filename or quality field
 */
function detectQuality(name = '') {
  const lower = name.toLowerCase();
  if (lower.includes('2160p') || lower.includes('4k')) return '2160p';
  if (lower.includes('1080p') && (lower.includes('h.265') || lower.includes('hevc'))) return '1080p HEVC';
  if (lower.includes('1080p')) return '1080p AVC';
  if (lower.includes('720p') && (lower.includes('h.265') || lower.includes('hevc'))) return '720p HEVC';
  if (lower.includes('720p')) return '720p AVC';
  if (lower.includes('480p')) return '480p';
  return 'Unknown';
}

/**
 * Normalizes Season and Episode numbers
 */
function detectSeasonEpisode(name = '') {
  const sMatch = name.match(/S0?(\d+)/i);
  const eMatch = name.match(/E0?(\d+)/i);
  return {
    season: sMatch ? parseInt(sMatch[1], 10) : null,
    episode: eMatch ? parseInt(eMatch[1], 10) : null
  };
}

/**
 * Sends a single batch to the Render API
 */
function sendBatch(items) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ items });
    const url = new URL(BATCH_ENDPOINT);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          resolve({ success: false, error: e.message, raw: data });
        }
      });
    });

    req.on('error', err => reject(err));
    req.write(payload);
    req.end();
  });
}

/**
 * Main importer function
 */
async function importFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`❌ File not found: ${resolvedPath}`);
    process.exit(1);
  }

  console.log(`📂 Reading data from: ${resolvedPath}`);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error('❌ Failed to parse JSON file:', e.message);
    process.exit(1);
  }

  const rawList = Array.isArray(data) ? data : (data.links || data.items || [data]);
  console.log(`📋 Found ${rawList.length} items to import.`);

  // Normalize items
  const cleanItems = [];
  for (const item of rawList) {
    const title = item.title || item.name || item.filename || 'Untitled';
    const filename = item.filename || title;
    const providerUrl = item.providerUrl || item.destination || item.url || item.link;

    if (!providerUrl) {
      console.warn(`⚠️ Skipping item without URL: "${title}"`);
      continue;
    }

    const { season, episode } = detectSeasonEpisode(filename);
    const quality = item.quality || detectQuality(filename);
    const isPack = item.scope === 'pack' || item.type === 'pack' || filename.toLowerCase().endsWith('.zip');

    cleanItems.push({
      sourceUrl: item.sourceUrl || `https://dataset.local/${encodeURIComponent(title)}`,
      title: title,
      filename: filename,
      providerUrl: providerUrl,
      mediatorUrl: item.mediatorUrl || item.sourceUrl || '',
      sizeDisplay: item.sizeDisplay || item.size || 'N/A',
      quality: quality,
      scope: isPack ? 'pack' : (season !== null ? 'series' : (item.scope || 'movie')),
      type: isPack ? 'pack' : (season !== null ? 'episode' : (item.type || 'movie')),
      season: season,
      episode: episode,
      provider: providerUrl.includes('hubcloud') ? 'hubcloud' : (item.provider || 'direct'),
      status: 'active'
    });
  }

  console.log(`✅ Normalized ${cleanItems.length} valid media records.`);

  // Upload in chunks of 50
  const CHUNK_SIZE = 50;
  let successCount = 0;

  for (let i = 0; i < cleanItems.length; i += CHUNK_SIZE) {
    const chunk = cleanItems.slice(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(cleanItems.length / CHUNK_SIZE);

    process.stdout.write(`⚡ Uploading Batch ${chunkNum}/${totalChunks} (${chunk.length} items)... `);
    try {
      const res = await sendBatch(chunk);
      if (res.success) {
        successCount += (res.count || chunk.length);
        console.log(`OK (Stored ${res.count || chunk.length} records)`);
      } else {
        console.log(`Failed: ${res.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.log(`Error: ${err.message}`);
    }
  }

  console.log(`\n🎉 Ingestion Complete! Successfully stored ${successCount} / ${cleanItems.length} records.`);
  console.log(`🔗 Target Endpoint: ${BATCH_ENDPOINT}`);
  console.log(`🚀 The Go Telegram Bot can now query these titles instantly!`);
}

const targetFile = process.argv[2];
if (!targetFile) {
  console.log(`
Usage:
  node scripts/import_media.js <path-to-json-file>

Examples:
  node scripts/import_media.js data/my_movies.json
  node scripts/import_media.js data/in_memory_scraped_links.json
  `);
  process.exit(0);
}

importFile(targetFile);
