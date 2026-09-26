import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dbManager } from '../src/database/mongodb.js';
import { jobsRepo, scrapedLinksRepo, SCRAPED_STATUS } from '../src/database/models.js';
import { jobQueue } from '../src/queue/job-queue.js';
import * as httpClient from '../src/discovery/http-client.js';
import '../src/providers/gdflix.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '../fixtures');

describe('Phase 7: End-to-End Modular Pipeline', () => {
  const sourceHtml = fs.readFileSync(path.join(fixturesDir, 'source-page.html'), 'utf-8');
  const intermediateHtml = fs.readFileSync(path.join(fixturesDir, 'intermediate-page.html'), 'utf-8');
  const gdflixHtml = fs.readFileSync(path.join(fixturesDir, 'gdflix-page.html'), 'utf-8');
  const captchaHtml = fs.readFileSync(path.join(fixturesDir, 'captcha-page.html'), 'utf-8');

  beforeEach(async () => {
    await dbManager.connect('mongodb://localhost:27017/test_db', { forceInMemory: true });
    await scrapedLinksRepo.initIndexes();
    await jobsRepo.initIndexes();
  });

  afterAll(async () => {
    await dbManager.disconnect();
    vi.restoreAllMocks();
  });

  it('runs complete pipeline from source page to GDFLIX resolution and MongoDB persistence', async () => {
    // Mock fetchWithControls to return appropriate fixture content per URL
    const fetchSpy = vi.spyOn(httpClient, 'fetchWithControls').mockImplementation(async (targetUrl) => {
      if (targetUrl.includes('tvshows/example-show')) {
        return {
          success: true,
          status: 200,
          url: targetUrl,
          finalUrl: targetUrl,
          redirectChain: [],
          body: sourceHtml,
          verificationRequired: false,
        };
      }
      if (targetUrl.includes('/some/path') || targetUrl.includes('/intermediate')) {
        return {
          success: true,
          status: 200,
          url: targetUrl,
          finalUrl: 'https://example-authorized-site.test/intermediate?file=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9',
          redirectChain: ['https://example-authorized-site.test/some/path'],
          body: intermediateHtml,
          verificationRequired: false,
        };
      }
      if (targetUrl.includes('gdflix.example') || targetUrl.includes('/file/')) {
        return {
          success: true,
          status: 200,
          url: targetUrl,
          finalUrl: targetUrl,
          redirectChain: [],
          body: gdflixHtml,
          verificationRequired: false,
        };
      }
      return {
        success: false,
        status: 404,
        url: targetUrl,
        finalUrl: targetUrl,
        redirectChain: [],
        body: 'Not found',
        verificationRequired: false,
      };
    });

    const sourceUrl = 'https://example-authorized-site.test/tvshows/example-show/';
    const job = await jobQueue.addJob(sourceUrl);

    // Wait for queue processing to complete
    let attempts = 0;
    let finalJob = null;
    while (attempts < 20) {
      await new Promise((r) => setTimeout(r, 50));
      finalJob = await jobsRepo.getJob(job._id);
      if (finalJob.status === SCRAPED_STATUS.RESOLVED || finalJob.status === SCRAPED_STATUS.PARTIAL) {
        break;
      }
      attempts++;
    }

    expect(finalJob.status).toBe(SCRAPED_STATUS.RESOLVED);
    expect(finalJob.resultsCount).toBeGreaterThan(0);

    // Verify stored MongoDB document
    const records = await scrapedLinksRepo.find({ sourceUrl });
    expect(records.length).toBeGreaterThan(0);

    const record = records[0];
    expect(record.title).toBe('Example Show');
    expect(record.year).toBe(2026);
    expect(record.type).toBe('tv');
    expect(record.season).toBe(1);
    expect(record.quality).toBe('2160p');
    expect(record.codec).toBe('H.265');
    expect(record.provider).toBe('GDFLIX');
    expect(record.fileId).toBe('9QWlfgZTmmiv837');
    expect(record.filename).toBe('Example.Show.2026.S01.2160p.HS.WEB-DL.MULTI.DDPA.5.1.Atmos.H.265.zip');
    expect(record.format).toBe('zip');
    expect(record.sizeDisplay).toBe('39.47 GB');
    expect(record.sizeBytes).toBeGreaterThan(40000000000);
    expect(record.mirrors.length).toBe(2);
    expect(record.status).toBe(SCRAPED_STATUS.RESOLVED);

    // Verify duplicate prevention on subsequent scrape
    await jobQueue.executeJob(job._id);
    const countAfter = await scrapedLinksRepo.count({ sourceUrl });
    expect(countAfter).toBe(records.length); // Count should remain identical

    fetchSpy.mockRestore();
  });

  it('stops cleanly and records HUMAN_VERIFICATION_REQUIRED when challenge is encountered', async () => {
    const fetchSpy = vi.spyOn(httpClient, 'fetchWithControls').mockImplementation(async (targetUrl) => {
      return {
        success: false,
        status: 200,
        url: targetUrl,
        finalUrl: targetUrl,
        redirectChain: [],
        body: captchaHtml,
        verificationRequired: true,
        challengeResult: {
          status: 'HUMAN_VERIFICATION_REQUIRED',
          message: 'Manual verification required.',
        },
      };
    });

    const challengeUrl = 'https://example-authorized-site.test/protected-page';
    const job = await jobQueue.addJob(challengeUrl);

    let attempts = 0;
    let finalJob = null;
    while (attempts < 20) {
      await new Promise((r) => setTimeout(r, 50));
      finalJob = await jobsRepo.getJob(job._id);
      if (finalJob.status === SCRAPED_STATUS.HUMAN_VERIFICATION_REQUIRED) {
        break;
      }
      attempts++;
    }

    expect(finalJob.status).toBe(SCRAPED_STATUS.HUMAN_VERIFICATION_REQUIRED);
    expect(finalJob.error).toMatch(/manual verification required/i);

    fetchSpy.mockRestore();
  });
});
