/**
 * MongoDB Pre-Indexing & Cache Pre-Warm Setup Script
 *
 * Establishes optimized single-field, compound, and covering indexes
 * on MongoDB collections (`scraped_links` and `scrape_jobs`) for sub-millisecond
 * cache resolution in both Node.js API and the Go Telegram Bot daemon.
 *
 * Usage:
 *   node scripts/setup-mongodb-indexes.js [--prewarm] [--uri <mongodb_uri>]
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const shouldPrewarm = args.includes('--prewarm') || true; // Prewarm by default if data file exists
const uriIndex = args.indexOf('--uri');
const MONGODB_URI = (uriIndex !== -1 && args[uriIndex + 1])
  ? args[uriIndex + 1]
  : (process.env.MONGODB_URI || 'mongodb://localhost:27017/scraper_db');

console.log('====================================================');
console.log('⚡  MongoDB Pre-Index & Cache Acceleration Setup');
console.log('====================================================');
console.log(`Target URI: ${MONGODB_URI.replace(/\/\/.*@/, '//***@')}`);

async function run() {
  let client;
  try {
    client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });

    console.log('Connecting to MongoDB...');
    await client.connect();
    console.log('✓ Successfully connected to MongoDB server.');

    const db = client.db();
    console.log(`Database: ${db.databaseName}\n`);

    // ─────────────────────────────────────────────────────────────
    // 1. Pre-index `scraped_links`
    // ─────────────────────────────────────────────────────────────
    console.log('--- Setting up indexes for [scraped_links] ---');
    const linksCol = db.collection('scraped_links');

    const linkIndexes = [
      // Primary deduplication & uniqueness constraint
      { key: { dedupeKey: 1 }, options: { unique: true, name: 'uniq_dedupeKey' } },

      // High-frequency cache lookup keys
      { key: { mediatorUrl: 1 }, options: { name: 'idx_mediatorUrl' } },
      { key: { original_url: 1 }, options: { name: 'idx_original_url' } },
      { key: { sourceUrl: 1 }, options: { name: 'idx_sourceUrl' } },
      { key: { providerUrl: 1 }, options: { name: 'idx_providerUrl' } },
      { key: { fileId: 1 }, options: { name: 'idx_fileId' } },

      // Title & search normalization
      { key: { normalizedTitle: 1 }, options: { name: 'idx_normalizedTitle' } },
      { key: { status: 1 }, options: { name: 'idx_status' } },

      // High-speed covering index for L3 cache hit without fetching full doc
      {
        key: { mediatorUrl: 1, providerUrl: 1, status: 1, title: 1 },
        options: { name: 'idx_cache_covering_mediator' },
      },
      {
        key: { sourceUrl: 1, status: 1 },
        options: { name: 'idx_sourceUrl_status' },
      },
      {
        key: { normalizedTitle: 1, quality: 1, season: 1, episode: 1 },
        options: { name: 'idx_title_quality_ep' },
      },
      {
        key: { updatedAt: -1 },
        options: { name: 'idx_updatedAt_desc' },
      },
    ];

    for (const idx of linkIndexes) {
      try {
        const name = await linksCol.createIndex(idx.key, idx.options);
        console.log(`  ✓ Created index: ${name}`);
      } catch (err) {
        if (err.codeName === 'IndexOptionsConflict' || err.code === 85) {
          console.log(`  ℹ Index exists with alternative options: ${idx.options.name}`);
        } else {
          console.warn(`  ⚠️ Warning creating ${idx.options.name}: ${err.message}`);
        }
      }
    }

    // Full-text search index on title and filename
    try {
      const textName = await linksCol.createIndex(
        { title: 'text', filename: 'text' },
        { name: 'idx_text_search', weights: { title: 10, filename: 5 } }
      );
      console.log(`  ✓ Created text search index: ${textName}`);
    } catch (err) {
      console.log(`  ℹ Text index check: ${err.message}`);
    }

    // ─────────────────────────────────────────────────────────────
    // 2. Pre-index `scrape_jobs`
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Setting up indexes for [scrape_jobs] ---');
    const jobsCol = db.collection('scrape_jobs');

    const jobIndexes = [
      { key: { status: 1 }, options: { name: 'idx_job_status' } },
      { key: { createdAt: -1 }, options: { name: 'idx_job_createdAt_desc' } },
      { key: { url: 1 }, options: { name: 'idx_job_url' } },
    ];

    for (const idx of jobIndexes) {
      try {
        const name = await jobsCol.createIndex(idx.key, idx.options);
        console.log(`  ✓ Created index: ${name}`);
      } catch (err) {
        console.warn(`  ⚠️ Warning creating ${idx.options.name}: ${err.message}`);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 3. Pre-warm Cache from local in_memory_scraped_links.json
    // ─────────────────────────────────────────────────────────────
    if (shouldPrewarm) {
      const dataFilePath = path.resolve(__dirname, '..', 'data', 'in_memory_scraped_links.json');
      if (fs.existsSync(dataFilePath)) {
        console.log('\n--- Pre-warming MongoDB Cache from local dataset ---');
        try {
          const raw = fs.readFileSync(dataFilePath, 'utf8');
          const records = JSON.parse(raw);
          if (Array.isArray(records) && records.length > 0) {
            console.log(`Found ${records.length} records in local in-memory dataset.`);
            let upsertedCount = 0;
            for (const r of records) {
              const dedupeKey = r.dedupeKey || `${r.sourceUrl}::${r.mediatorUrl || r.providerUrl}`;
              await linksCol.updateOne(
                { dedupeKey },
                {
                  $set: {
                    ...r,
                    dedupeKey,
                    updatedAt: new Date(r.updatedAt || Date.now()),
                    createdAt: new Date(r.createdAt || Date.now()),
                  },
                },
                { upsert: true }
              );
              upsertedCount++;
            }
            console.log(`✓ Pre-warmed ${upsertedCount} link records into MongoDB collection.`);
          }
        } catch (e) {
          console.warn(`Could not pre-warm from ${dataFilePath}: ${e.message}`);
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 4. Verification & Statistics
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Verifying Active Indexes ---');
    const existingIndexes = await linksCol.indexes();
    console.log(`Total active indexes on [scraped_links]: ${existingIndexes.length}`);
    for (const idx of existingIndexes) {
      console.log(`  • ${idx.name} => ${JSON.stringify(idx.key)}`);
    }

    const docCount = await linksCol.countDocuments();
    console.log(`Total documents ready for instant cache lookup: ${docCount}`);

    console.log('\n====================================================');
    console.log('✅  MongoDB is fully pre-indexed and ready for instant caching!');
    console.log('====================================================\n');
  } catch (err) {
    console.error('\n❌ MongoDB Pre-Index Failed:');
    console.error(err.message);
    if (err.message.includes('ECONNREFUSED') || err.message.includes('serverSelectionTimeoutMS')) {
      console.log('\nTip: If running without a local MongoDB service, provide your MongoDB Atlas connection string:');
      console.log('  node scripts/setup-mongodb-indexes.js --uri "mongodb+srv://<user>:<password>@cluster0.mongodb.net/scraper_db"\n');
    }
    process.exit(1);
  } finally {
    if (client) {
      await client.close();
    }
  }
}

run();
