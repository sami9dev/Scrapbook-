import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { dbManager } from '../src/database/mongodb.js';
import { scrapedLinksRepo, jobsRepo, SCRAPED_STATUS } from '../src/database/models.js';
import { generateDedupeKey } from '../src/utils/dedupe.js';

describe('Phase 4: MongoDB Schema & Deduplication', () => {
  beforeEach(async () => {
    // Force in-memory mode for clean unit tests
    await dbManager.connect('mongodb://localhost:27017/test_db', { forceInMemory: true });
    await scrapedLinksRepo.initIndexes();
    await jobsRepo.initIndexes();
  });

  afterAll(async () => {
    await dbManager.disconnect();
  });

  it('saves and retrieves scraped link matching required schema', async () => {
    const record = {
      sourceUrl: 'https://example-authorized-site.test/tvshows/example-show/',
      sourceDomain: 'example-authorized-site.test',
      title: 'Example Show',
      year: 2026,
      type: 'tv',
      season: 1,
      episode: null,
      quality: '2160p',
      codec: 'H.265',
      provider: 'GDFLIX',
      providerUrl: 'https://provider.example/file/9QWlfgZTmmiv837',
      fileId: '9QWlfgZTmmiv837',
      filename: 'Example.Show.2026.S01.2160p.HS.WEB-DL.MULTI.DDPA.5.1.Atmos.H.265.zip',
      format: 'zip',
      sizeBytes: 42380591104,
      sizeDisplay: '39.47 GB',
      mirrors: [
        { name: 'Mirror 1', url: 'https://mirror1.example/download/fast123', type: 'direct' },
      ],
      status: SCRAPED_STATUS.RESOLVED,
      redirectChain: ['https://example-authorized-site.test/some/path'],
    };

    const saved = await scrapedLinksRepo.saveLink(record);

    expect(saved._id).toBeDefined();
    expect(saved.title).toBe('Example Show');
    expect(saved.year).toBe(2026);
    expect(saved.quality).toBe('2160p');
    expect(saved.fileId).toBe('9QWlfgZTmmiv837');
    expect(saved.mirrors.length).toBe(1);
    expect(saved.status).toBe(SCRAPED_STATUS.RESOLVED);

    const fetched = await scrapedLinksRepo.findById(saved._id);
    expect(fetched).toBeDefined();
    expect(fetched.dedupeKey).toBe(generateDedupeKey(record));
  });

  it('prevents duplicates by updating existing record on same compound key', async () => {
    const record1 = {
      sourceUrl: 'https://example-authorized-site.test/tvshows/example-show/',
      providerUrl: 'https://provider.example/file/9QWlfgZTmmiv837',
      fileId: '9QWlfgZTmmiv837',
      title: 'Example Show Initial',
      status: SCRAPED_STATUS.DISCOVERED,
    };

    const first = await scrapedLinksRepo.saveLink(record1);

    const record2 = {
      sourceUrl: 'https://example-authorized-site.test/tvshows/example-show/',
      providerUrl: 'https://provider.example/file/9QWlfgZTmmiv837',
      fileId: '9QWlfgZTmmiv837',
      title: 'Example Show Updated',
      status: SCRAPED_STATUS.RESOLVED,
    };

    const second = await scrapedLinksRepo.saveLink(record2);

    expect(second._id).toBe(first._id);
    expect(second.title).toBe('Example Show Updated');
    expect(second.status).toBe(SCRAPED_STATUS.RESOLVED);

    const totalCount = await scrapedLinksRepo.count();
    expect(totalCount).toBe(1); // No duplicate document created
  });

  it('tracks explicit job statuses and metrics', async () => {
    const job = await jobsRepo.createJob('https://example-authorized-site.test/page-1');
    expect(job.status).toBe(SCRAPED_STATUS.DISCOVERED);

    await jobsRepo.updateJob(job._id, { status: SCRAPED_STATUS.PARSING });
    const parsingJob = await jobsRepo.getJob(job._id);
    expect(parsingJob.status).toBe(SCRAPED_STATUS.PARSING);

    await jobsRepo.updateJob(job._id, { status: SCRAPED_STATUS.RESOLVED, resultsCount: 2 });
    const resolvedJob = await jobsRepo.getJob(job._id);
    expect(resolvedJob.status).toBe(SCRAPED_STATUS.RESOLVED);
    expect(resolvedJob.resultsCount).toBe(2);

    // Create a job requiring human verification
    const challengeJob = await jobsRepo.createJob('https://example-authorized-site.test/captcha-page');
    await jobsRepo.updateJob(challengeJob._id, { status: SCRAPED_STATUS.HUMAN_VERIFICATION_REQUIRED });

    // Create an error job
    const errorJob = await jobsRepo.createJob('https://example-authorized-site.test/broken');
    await jobsRepo.updateJob(errorJob._id, { status: SCRAPED_STATUS.ERROR, error: 'Connection failed' });

    const stats = await jobsRepo.getStats();
    expect(stats.total).toBe(3);
    expect(stats.resolved).toBe(1);
    expect(stats.humanVerification).toBe(1);
    expect(stats.errors).toBe(1);
  });
});
