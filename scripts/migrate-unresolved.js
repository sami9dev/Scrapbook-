import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithControls } from '../src/discovery/http-client.js';
import { extractEmbeddedMediatorPayload } from '../src/resolvers/mediator/http-first.js';
import { extractHubCloudDriveId } from '../src/providers/hubcloud/validator.js';
import { dbManager } from '../src/database/mongodb.js';
import { scrapedLinksRepo } from '../src/database/models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrate() {
  const filePath = path.resolve(__dirname, '..', 'data', 'in_memory_scraped_links.json');
  if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    return;
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const unresolved = data.filter((d) => (!d.providerUrl || d.status !== 'RESOLVED') && d.mediatorUrl);
  console.log(`Found ${unresolved.length} unresolved mediator links out of ${data.length} total links.`);

  const urlMap = new Map();
  for (const item of unresolved) {
    if (!urlMap.has(item.mediatorUrl)) {
      urlMap.set(item.mediatorUrl, []);
    }
    urlMap.get(item.mediatorUrl).push(item);
  }

  const uniqueUrls = Array.from(urlMap.keys());
  console.log(`Processing ${uniqueUrls.length} unique mediator URLs...`);

  let resolvedCount = 0;
  let index = 0;
  const concurrency = 20;

  async function worker() {
    while (index < uniqueUrls.length) {
      const u = uniqueUrls[index++];
      try {
        const res = await fetchWithControls(u, { timeout: 4500, maxRetries: 2 });
        if (res.body) {
          const dest = extractEmbeddedMediatorPayload(res.body);
          if (dest && (/hubcloud/i.test(dest) || /hubdrive/i.test(dest))) {
            const items = urlMap.get(u) || [];
            for (const item of items) {
              item.providerUrl = dest;
              item.provider = /hubdrive/i.test(dest) ? 'HubDrive' : 'HubCloud';
              item.status = 'RESOLVED';
              item.fileId = extractHubCloudDriveId(dest) || dest.split('/').pop();
            }
            resolvedCount++;
          }
        }
      } catch (err) {
        // ignore
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`Successfully resolved ${resolvedCount}/${uniqueUrls.length} unique mediator links directly to HubCloud!`);

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Saved updated in_memory_scraped_links.json.`);

  // Connect to MongoDB and update documents if connected
  try {
    await dbManager.connect();
    const mongoUnresolved = await scrapedLinksRepo.find({ status: 'DISCOVERED' });
    console.log(`Found ${mongoUnresolved.length} DISCOVERED records in MongoDB.`);
    let mongoUpdated = 0;
    for (const doc of mongoUnresolved) {
      if (doc.mediatorUrl && urlMap.has(doc.mediatorUrl)) {
        const matchingItem = urlMap.get(doc.mediatorUrl)[0];
        if (matchingItem && matchingItem.providerUrl && matchingItem.status === 'RESOLVED') {
          doc.providerUrl = matchingItem.providerUrl;
          doc.fileId = matchingItem.fileId;
          doc.status = 'RESOLVED';
          await scrapedLinksRepo.saveLink(doc);
          mongoUpdated++;
        }
      }
    }
    console.log(`Updated ${mongoUpdated} records in MongoDB.`);
    await dbManager.disconnect();
  } catch (mErr) {
    console.log(`MongoDB update skipped: ${mErr.message}`);
  }

  const stillUnresolved = data.filter((d) => !d.providerUrl || d.status !== 'RESOLVED');
  console.log(`Final remaining unresolved links: ${stillUnresolved.length}`);
}

migrate()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
