import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import { dbManager } from '../src/database/mongodb.js';
import { jobsRepo, scrapedLinksRepo, SCRAPED_STATUS } from '../src/database/models.js';
import apiRoutes from '../src/api/routes.js';
import { renderWithBrowser } from '../src/discovery/browser-fetcher.js';

describe('Phase 5: REST API Endpoints', () => {
  let app;

  beforeEach(async () => {
    await dbManager.connect('mongodb://localhost:27017/test_db', { forceInMemory: true });
    await jobsRepo.initIndexes();
    await scrapedLinksRepo.initIndexes();

    app = express();
    app.use(express.json());
    app.use('/api', apiRoutes);
  });

  afterAll(async () => {
    await dbManager.disconnect();
  });

  it('POST /api/scrape validates URL and blocks SSRF attempts', async () => {
    // Helper to invoke express route
    const postScrape = async (payload) => {
      const req = { body: payload };
      let statusCode = 200;
      let responseBody = null;
      const res = {
        status: (code) => {
          statusCode = code;
          return res;
        },
        json: (data) => {
          responseBody = data;
          return res;
        },
      };

      // Find route handler
      const layer = apiRoutes.stack.find((s) => s.route?.path === '/scrape' && s.route?.methods?.post);
      await layer.route.stack[0].handle(req, res);
      return { status: statusCode, body: responseBody };
    };

    // Missing URL
    const res1 = await postScrape({});
    expect(res1.status).toBe(400);
    expect(res1.body.error).toMatch(/required/i);

    // SSRF attempt
    const res2 = await postScrape({ url: 'http://169.254.169.254/metadata' });
    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/SSRF blocked/i);

    // Valid authorized URL
    const res3 = await postScrape({ url: 'https://example-authorized-site.test/tvshows/example-show/' });
    expect(res3.status).toBe(202);
    expect(res3.body.jobId).toBeDefined();
    expect(res3.body.status).toBe(SCRAPED_STATUS.DISCOVERED);
  });

  it('POST /api/scrape accepts target quality and GET /api/links filters by quality', async () => {
    const reqPost = { body: { url: 'https://example-authorized-site.test/tvshows/example-show/', quality: '2160p' } };
    let resPostData = null;
    const resPost = {
      status: () => resPost,
      json: (d) => (resPostData = d),
    };
    const scrapeLayer = apiRoutes.stack.find((s) => s.route?.path === '/scrape' && s.route?.methods?.post);
    await scrapeLayer.route.stack[0].handle(reqPost, resPost);

    expect(resPostData.targetQuality).toBe('2160p');

    await scrapedLinksRepo.saveLink({
      sourceUrl: 'https://example-authorized-site.test/quality-test-4k',
      title: 'Show 4K',
      quality: '2160p',
      provider: 'GDFLIX',
      providerUrl: 'https://gdflix.example/file/4k123',
      status: SCRAPED_STATUS.RESOLVED,
    });
    await scrapedLinksRepo.saveLink({
      sourceUrl: 'https://example-authorized-site.test/quality-test-1080',
      title: 'Show 1080p',
      quality: '1080p',
      provider: 'GDFLIX',
      providerUrl: 'https://gdflix.example/file/1080123',
      status: SCRAPED_STATUS.RESOLVED,
    });

    const reqGet = { query: { quality: '2160p' } };
    let resGetData = null;
    const resGet = { json: (d) => (resGetData = d) };
    const linksLayer = apiRoutes.stack.find((s) => s.route?.path === '/links' && s.route?.methods?.get);
    await linksLayer.route.stack[0].handle(reqGet, resGet);

    expect(Array.isArray(resGetData)).toBe(true);
    expect(resGetData.length).toBeGreaterThan(0);
    expect(resGetData.every((l) => l.quality === '2160p')).toBe(true);
  });

  it('GET /api/jobs/:id returns job details or 404', async () => {
    const job = await jobsRepo.createJob('https://example-authorized-site.test/item');

    const getJob = async (id) => {
      const req = { params: { id } };
      let statusCode = 200;
      let responseBody = null;
      const res = {
        status: (code) => {
          statusCode = code;
          return res;
        },
        json: (data) => {
          responseBody = data;
          return res;
        },
      };
      const layer = apiRoutes.stack.find((s) => s.route?.path === '/jobs/:id');
      await layer.route.stack[0].handle(req, res);
      return { status: statusCode, body: responseBody };
    };

    const found = await getJob(job._id);
    expect(found.status).toBe(200);
    expect(found.body._id).toBe(job._id);

    const notFound = await getJob('non-existent-id');
    expect(notFound.status).toBe(404);
  });

  it('GET /api/links and /api/links/:id return scraped link records', async () => {
    const saved = await scrapedLinksRepo.saveLink({
      sourceUrl: 'https://example-authorized-site.test/page',
      title: 'API Test Title',
      quality: '1080p',
      provider: 'GDFLIX',
      fileId: 'test123',
    });

    const getLinks = async () => {
      const req = { query: {} };
      let responseBody = null;
      const res = { json: (data) => (responseBody = data) };
      const layer = apiRoutes.stack.find((s) => s.route?.path === '/links');
      await layer.route.stack[0].handle(req, res);
      return responseBody;
    };

    const links = await getLinks();
    expect(Array.isArray(links)).toBe(true);
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].title).toBe('API Test Title');

    const getLinkById = async (id) => {
      const req = { params: { id } };
      let statusCode = 200;
      let responseBody = null;
      const res = {
        status: (code) => {
          statusCode = code;
          return res;
        },
        json: (data) => {
          responseBody = data;
          return res;
        },
      };
      const layer = apiRoutes.stack.find((s) => s.route?.path === '/links/:id');
      await layer.route.stack[0].handle(req, res);
      return { status: statusCode, body: responseBody };
    };

    const single = await getLinkById(saved._id);
    expect(single.status).toBe(200);
    expect(single.body.fileId).toBe('test123');

    const missing = await getLinkById('missing-id');
    expect(missing.status).toBe(404);
  });

  it('GET /api/stats returns aggregated metrics', async () => {
    const getStats = async () => {
      const req = {};
      let responseBody = null;
      const res = { json: (data) => (responseBody = data) };
      const layer = apiRoutes.stack.find((s) => s.route?.path === '/stats');
      await layer.route.stack[0].handle(req, res);
      return responseBody;
    };

    const stats = await getStats();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('resolved');
    expect(stats).toHaveProperty('partial');
    expect(stats).toHaveProperty('humanVerification');
    expect(stats).toHaveProperty('errors');
  });

  it('POST /api/reset clears all scraped links and jobs', async () => {
    // Insert dummy record
    await scrapedLinksRepo.saveLink({
      sourceUrl: 'https://example.com/old',
      title: 'Old Title',
      provider: 'OLD',
      providerUrl: 'https://example.com/file/old',
      fileId: 'old123',
    });
    await jobsRepo.createJob({ url: 'https://example.com/old' });

    expect(await scrapedLinksRepo.count()).toBeGreaterThan(0);
    expect((await jobsRepo.listJobs()).length).toBeGreaterThan(0);

    const postReset = async () => {
      const req = {};
      let statusCode = 200;
      let responseBody = null;
      const res = {
        status: (code) => {
          statusCode = code;
          return res;
        },
        json: (data) => {
          responseBody = data;
          return res;
        },
      };
      const layer = apiRoutes.stack.find((s) => s.route?.path === '/reset' && s.route?.methods?.post);
      await layer.route.stack[0].handle(req, res);
      return { status: statusCode, body: responseBody };
    };

    const resetRes = await postReset();
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.success).toBe(true);

    expect(await scrapedLinksRepo.count()).toBe(0);
    expect(await jobsRepo.listJobs()).toHaveLength(0);
  });

  it('POST /api/parse-html parses HTML directly and supports autoReset', async () => {
    const postParseHtml = async (payload) => {
      const req = { body: payload };
      let statusCode = 200;
      let responseBody = null;
      const res = {
        status: (code) => {
          statusCode = code;
          return res;
        },
        json: (data) => {
          responseBody = data;
          return res;
        },
      };
      const layer = apiRoutes.stack.find((s) => s.route?.path === '/parse-html' && s.route?.methods?.post);
      await layer.route.stack[0].handle(req, res);
      return { status: statusCode, body: responseBody };
    };

    const dummyHtml = `
      <div class="cmz-row-card">
        <div class="cmz-row-title">My.Show.S01E01.2160p.WEB-DL.mkv</div>
        <div class="cmz-btn-group">
          <a href="https://gdflix.example/file/sample123" class="cmz-download-btn">5.2 GB</a>
        </div>
      </div>
    `;

    const res = await postParseHtml({
      html: dummyHtml,
      sourceUrl: 'https://mysite.example/tv/myshow',
      quality: '2160p',
      autoReset: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.records[0].filename).toBe('My.Show.S01E01.2160p.WEB-DL.mkv');
    expect(res.body.records[0].quality).toBe('2160p');
    expect(res.body.records[0].provider).toBe('GDFLIX');
  });
});

describe('Phase 6: Browser Automation & Boundary Enforcement', () => {
  it('blocks private IP addresses before launching browser (SSRF prevention)', async () => {
    const result = await renderWithBrowser('http://192.168.1.1/admin');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/security error/i);
  });
});
