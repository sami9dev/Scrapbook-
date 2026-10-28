import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractPageLinks,
  escapeCsvField,
  formatRecordsToCsv,
  RobotsChecker,
  LinkResolver,
  LinkCollector,
  AssistedResolver,
} from '../src/tools/link-collector/index.js';

describe('Link Collector & Redirect Resolver Suite', () => {
  describe('Extractor (extractPageLinks)', () => {
    it('extracts and normalizes links relative to base URL', () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head><title>Test Source Page</title></head>
        <body>
          <a href="/about">About Us</a>
          <a href="https://example.org/docs">Documentation</a>
          <a href="contact.html">Contact</a>
          <a href="#section">Skip to content</a>
          <a href="javascript:void(0)">Click me</a>
          <a href="mailto:test@example.com">Email</a>
        </body>
        </html>
      `;

      const result = extractPageLinks(html, 'https://example.com/sub/');

      expect(result.title).toBe('Test Source Page');
      expect(result.links).toHaveLength(3);
      expect(result.links[0].url).toBe('https://example.com/about');
      expect(result.links[0].text).toBe('About Us');
      expect(result.links[1].url).toBe('https://example.org/docs');
      expect(result.links[2].url).toBe('https://example.com/sub/contact.html');
    });

    it('deduplicates identical URLs on the same page', () => {
      const html = `
        <a href="/page1">Link 1</a>
        <a href="/page1">Link 1 again</a>
        <a href="/page2">Link 2</a>
      `;
      const result = extractPageLinks(html, 'https://example.com/');
      expect(result.links).toHaveLength(2);
      expect(result.links.map((l) => l.url)).toEqual([
        'https://example.com/page1',
        'https://example.com/page2',
      ]);
    });
  });

  describe('CSV Formatter', () => {
    it('escapes fields with commas, quotes, and newlines per RFC 4180', () => {
      expect(escapeCsvField('normal')).toBe('"normal"');
      expect(escapeCsvField('hello, world')).toBe('"hello, world"');
      expect(escapeCsvField('hello "world"')).toBe('"hello ""world"""');
      expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
      expect(escapeCsvField(200)).toBe('"200"');
      expect(escapeCsvField(null)).toBe('""');
    });

    it('formats record list into RFC 4180 CSV rows', () => {
      const records = [
        {
          originalUrl: 'https://short.url/abc',
          finalUrl: 'https://dest.com/item,1',
          httpStatus: 200,
          pageTitle: 'Item "1" - Store',
          redirectCount: 1,
          sourceUrl: 'https://start.com/',
          error: null,
        },
      ];

      const csv = formatRecordsToCsv(records);
      const lines = csv.split('\r\n');

      expect(lines[0]).toBe('Original URL,Final URL,HTTP Status,Page Title,Redirect Count,Source Page,Error / Status Note');
      expect(lines[1]).toContain('"https://short.url/abc"');
      expect(lines[1]).toContain('"https://dest.com/item,1"');
      expect(lines[1]).toContain('"Item ""1"" - Store"');
      expect(lines[1]).toContain('"200"');
    });
  });

  describe('RobotsChecker', () => {
    it('parses allow and disallow directives correctly', () => {
      const checker = new RobotsChecker();
      const robotsTxt = `
User-agent: *
Disallow: /private/
Disallow: /admin/
Allow: /private/public-doc
Crawl-delay: 2
`;
      const parsed = checker._parseRobotsText(robotsTxt);
      expect(parsed.crawlDelay).toBe(2);
      expect(parsed.rules).toHaveLength(3);

      checker.cache.set('https://mocked.test', {
        rules: parsed.rules,
        crawlDelay: parsed.crawlDelay,
        fetchedAt: Date.now(),
      });

      return Promise.all([
        checker.isAllowed('https://mocked.test/public/page').then((res) => {
          expect(res.allowed).toBe(true);
        }),
        checker.isAllowed('https://mocked.test/private/secret').then((res) => {
          expect(res.allowed).toBe(false);
          expect(res.reason).toContain('Disallow /private/');
        }),
        checker.isAllowed('https://mocked.test/private/public-doc').then((res) => {
          expect(res.allowed).toBe(true);
        }),
      ]);
    });
  });

  describe('LinkResolver HTTP Redirection', () => {
    let server;
    let baseUrl;

    beforeEach(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/hop1') {
          res.writeHead(302, { Location: '/hop2' });
          res.end();
        } else if (req.url === '/hop2') {
          res.writeHead(301, { Location: '/final' });
          res.end();
        } else if (req.url === '/final') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<!DOCTYPE html><html><head><title>Destination Page Title</title></head><body>OK</body></html>');
        } else if (req.url === '/loop1') {
          res.writeHead(302, { Location: '/loop2' });
          res.end();
        } else if (req.url === '/loop2') {
          res.writeHead(302, { Location: '/loop1' });
          res.end();
        } else if (req.url === '/notfound') {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<title>Not Found</title>');
        } else if (req.url === '/protected') {
          res.writeHead(401, { 'Content-Type': 'text/html' });
          res.end('<title>Login Required</title>');
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('follows multiple redirect hops and extracts the final URL and page title', async () => {
      const resolver = new LinkResolver({ timeoutMs: 3000, maxRedirects: 5 });
      const result = await resolver.resolve(`${baseUrl}/hop1`);

      expect(result.httpStatus).toBe(200);
      expect(result.finalUrl).toBe(`${baseUrl}/final`);
      expect(result.redirectCount).toBe(2);
      expect(result.pageTitle).toBe('Destination Page Title');
      expect(result.error).toBeNull();
    });

    it('detects and halts on redirect loops without hanging', async () => {
      const resolver = new LinkResolver({ timeoutMs: 3000, maxRedirects: 5 });
      const result = await resolver.resolve(`${baseUrl}/loop1`);

      expect(result.error).toContain('Redirect loop detected');
      expect(result.redirectCount).toBeGreaterThanOrEqual(1);
    });

    it('gracefully reports 404 and 401 without attempting bypass', async () => {
      const resolver = new LinkResolver({ timeoutMs: 3000 });
      const res404 = await resolver.resolve(`${baseUrl}/notfound`);
      expect(res404.httpStatus).toBe(404);
      expect(res404.error).toBe('HTTP 404');

      const res401 = await resolver.resolve(`${baseUrl}/protected`);
      expect(res401.httpStatus).toBe(401);
      expect(res401.error).toBe('HTTP 401');
      expect(res401.pageTitle).toContain('Login Required');
    });
  });

  describe('LinkCollector Orchestration', () => {
    let server;
    let baseUrl;
    const testOutputDir = path.resolve('output/test_results');

    beforeEach(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/start') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>Start Hub</title></head>
              <body>
                <a href="/target-1">Target 1</a>
                <a href="/target-redirect">Target Redirect</a>
              </body>
            </html>
          `);
        } else if (req.url === '/target-1') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<title>Landing 1</title>');
        } else if (req.url === '/target-redirect') {
          res.writeHead(302, { Location: '/target-1' });
          res.end();
        } else if (req.url === '/robots.txt') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('User-agent: *\nAllow: /');
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (fs.existsSync(testOutputDir)) {
        fs.rmSync(testOutputDir, { recursive: true, force: true });
      }
    });

    it('extracts links from start page, resolves redirects, and generates CSV file', async () => {
      const csvPath = path.join(testOutputDir, 'links.csv');
      const progressList = [];

      const collector = new LinkCollector({
        concurrency: 2,
        delayMs: 10,
        timeoutMs: 3000,
        respectRobotsTxt: true,
        outputPath: csvPath,
        onProgress: (p) => progressList.push(p),
      });

      const res = await collector.run([`${baseUrl}/start`]);

      expect(res.records).toHaveLength(2);
      expect(res.summary.resolved).toBe(2);
      expect(progressList.length).toBeGreaterThanOrEqual(2);
      expect(fs.existsSync(csvPath)).toBe(true);

      const content = fs.readFileSync(csvPath, 'utf8');
      expect(content).toContain('Landing 1');
      expect(content).toContain(`${baseUrl}/target-redirect`);
    });
  });

  describe('AssistedResolver (Interactive Browser & Redirect Tracing)', () => {
    let server;
    let baseUrl;

    beforeEach(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/flow-start') {
          res.writeHead(302, {
            'Set-Cookie': 'session_token=test_session_123; Path=/',
            Location: '/flow-step2',
          });
          res.end();
        } else if (req.url === '/flow-step2') {
          res.writeHead(301, {
            Location: '/flow-final',
          });
          res.end();
        } else if (req.url === '/flow-final') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<!DOCTYPE html><html><head><title>Destination Landed</title></head><body>Welcome to final target</body></html>');
        } else if (req.url === '/missing-location') {
          // 302 with missing Location header
          res.writeHead(302, { 'Content-Type': 'text/plain' });
          res.end('Redirect with no location header');
        } else if (req.url === '/challenge-page') {
          // Page containing verification challenge that is not bypassed
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head><title>Verify Identity</title></head>
              <body>
                <div class="cf-turnstile" id="turnstileContainer">Verification Challenge</div>
                <button id="goToLinkBtn" disabled>Go to Link</button>
              </body>
            </html>
          `);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('records 3xx Location headers before navigation continues and preserves session cookies', async () => {
      const resolver = new AssistedResolver({
        headless: true,
        timeoutMs: 8000,
      });

      const result = await resolver.resolve(`${baseUrl}/flow-start`);

      expect(result.finalUrl).toBe(`${baseUrl}/flow-final`);
      expect(result.pageTitle).toBe('Destination Landed');
      expect(result.error).toBeNull();
      expect(result.redirectChain.length).toBeGreaterThanOrEqual(2);
      expect(result.redirectChain[0].status).toBe(302);
      expect(result.redirectChain[0].location).toBe('/flow-step2');
      expect(result.redirectChain[1].status).toBe(301);
      expect(result.redirectChain[1].location).toBe('/flow-final');

      // Verify session cookies are preserved
      expect(result.cookies.some((c) => c.name === 'session_token' && c.value === 'test_session_123')).toBe(true);
    });

    it('handles 3xx responses with missing Location header without throwing errors', async () => {
      const resolver = new AssistedResolver({
        headless: true,
        timeoutMs: 1500,
        navigationTimeoutMs: 1500,
      });

      const result = await resolver.resolve(`${baseUrl}/missing-location`);

      // Should not throw, records null location
      expect(result.redirectChain.some((r) => r.status === 302 && r.location === null)).toBe(true);
      expect(result.error).toBe('No destination issued by server for this verified session.');
    }, 15000);

    it('stops cleanly and returns clear error when verification challenge is not completed without attempting bypass', async () => {
      const resolver = new AssistedResolver({
        headless: true,
        timeoutMs: 1500, // Short timeout
      });

      const result = await resolver.resolve(`${baseUrl}/challenge-page`);

      expect(result.finalUrl).toBeNull();
      expect(result.error).toBe('No destination issued by server for this verified session.');
    }, 15000);

    it('handles navigation timeouts gracefully', async () => {
      const resolver = new AssistedResolver({
        headless: true,
        timeoutMs: 500,
        navigationTimeoutMs: 500,
      });

      // 10.255.255.1 is non-routable blackhole IP causing navigation timeout
      const result = await resolver.resolve('http://10.255.255.1:65432');

      expect(result.finalUrl).toBeNull();
      expect(result.error).toContain('timed out');
    }, 15000);
  });
});

