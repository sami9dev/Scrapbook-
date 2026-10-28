import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { extract4KHDHubLinks } from '../src/providers/4khdhub/extractor.js';
import { detectContentTypeFromUrl } from '../src/providers/4khdhub/parser.js';
import { isHubCloudDriveUrl, extractHubCloudDriveId, fetchHubCloudMetadata } from '../src/providers/hubcloud/validator.js';
import { resolveMediatorFlow } from '../src/resolvers/mediator/browser.js';
import { ResolverService } from '../src/services/resolverService.js';
import { STATES } from '../src/resolvers/mediator/stateMachine.js';

describe('4KHDHub → Mediator → HubCloud Resolver Test Suite (Section 22)', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    // Spin up local mock server for tests
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === '/movie-a') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Deadpool & Wolverine (2024) - 4KHDHub</title></head>
          <body>
            <h1 class="entry-title">Deadpool & Wolverine (2024)</h1>
            <div class="entry-content">
              <h3>Deadpool.and.Wolverine.2024.1080p.Hindi.English</h3>
              <p>Download Links:</p>
              <a href="${baseUrl}/mediator-countdown?id=dyn_med_123" class="btn btn-primary">
                Download HubCloud
              </a>
            </div>
          </body>
          </html>
        `);
      } else if (url.pathname === '/movie-b') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Oppenheimer (2023) - 4KHDHub</title></head>
          <body>
            <h1 class="entry-title">Oppenheimer (2023)</h1>
            <div class="entry-content">
              <h3>Oppenheimer.2023.2160p.UHD.English</h3>
              <a href="${baseUrl}/mediator-countdown?id=different_mediator_999">
                Download HubCloud
              </a>
            </div>
          </body>
          </html>
        `);
      } else if (url.pathname === '/multi-quality') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Dune: Part Two (2024)</title></head>
          <body>
            <h1>Dune: Part Two</h1>
            <div class="quality-section">
              <h2>4K 2160p Ultra HD</h2>
              <a href="${baseUrl}/mediator?q=2160">Download HubCloud</a>
            </div>
            <div class="quality-section">
              <h2>1080p Full HD</h2>
              <a href="${baseUrl}/mediator?q=1080">Download HubCloud</a>
            </div>
            <div class="quality-section">
              <h2>720p HD</h2>
              <a href="${baseUrl}/mediator?q=720">Download HubCloud</a>
            </div>
          </body>
          </html>
        `);
      } else if (url.pathname === '/series-episodes') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>House of the Dragon - Season 2</title></head>
          <body>
            <h1>House of the Dragon Season 2</h1>
            <div class="episode-box">
              <h4>Season 2 Episode 1 (1080p)</h4>
              <a href="${baseUrl}/mediator?ep=1">Download HubCloud</a>
            </div>
            <div class="episode-box">
              <h4>Season 2 Episode 2 (1080p)</h4>
              <a href="${baseUrl}/mediator?ep=2">Download HubCloud</a>
            </div>
          </body>
          </html>
        `);
      } else if (url.pathname === '/mediator-countdown') {
        // Simulates dynamic mediator page with countdown that reveals Get Link
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Fast Direct Link Generator</title></head>
          <body>
            <div id="countdown-wrapper">
              <span id="timer">1</span> seconds remaining...
            </div>
            <div id="link-container" style="display: none;">
              <a id="getLinkBtn" href="https://hubcloud.ist/drive/d3vug2udf3bu8iv">Get Link</a>
            </div>
            <script>
              setTimeout(() => {
                document.getElementById('countdown-wrapper').style.display = 'none';
                document.getElementById('link-container').style.display = 'block';
              }, 400);
            </script>
          </body>
          </html>
        `);
      } else if (url.pathname === '/mediator-captcha') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Just a moment... Attention Required!</title></head>
          <body>
            <div class="cf-turnstile" data-sitekey="0x4AAAAAA"></div>
            <p>Please verify you are a human to proceed.</p>
          </body>
          </html>
        `);
      } else if (url.pathname === '/mediator-invalid-dest') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Ad Page</title></head>
          <body>
            <a href="https://some-unrelated-ad-site.test/promo">Get Link</a>
          </body>
          </html>
        `);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Test A — normal movie
  it('Test A: Normal movie flow (4KHDHub → mediator → countdown → Get Link → HubCloud)', async () => {
    // 1. Fetch & extract 4KHDHub content page
    const res = await fetch(`${baseUrl}/movie-a`);
    const html = await res.text();
    const extracted = extract4KHDHubLinks(html, `${baseUrl}/movie-a`);

    expect(extracted.links.length).toBe(1);
    expect(extracted.links[0].provider).toBe('HubCloud');
    expect(extracted.links[0].quality).toBe('1080p');
    expect(extracted.links[0].mediatorUrl).toContain('dyn_med_123');

    // 2. Run mediator browser flow
    const resolution = await resolveMediatorFlow(extracted.links[0].mediatorUrl, {
      meta: extracted.links[0],
      countdownTimeout: 5000,
      navigationTimeout: 5000,
    });

    expect(resolution.success).toBe(true);
    expect(resolution.state).toBe(STATES.HUBCLOUD_DETECTED);
    expect(isHubCloudDriveUrl(resolution.destination)).toBe(true);
    expect(resolution.destination).toBe('https://hubcloud.ist/drive/d3vug2udf3bu8iv');
    expect(extractHubCloudDriveId(resolution.destination)).toBe('d3vug2udf3bu8iv');
  });

  // Test B — different movie
  it('Test B: Different movie extracts mediator URL dynamically without hardcoded values', async () => {
    const resA = await fetch(`${baseUrl}/movie-a`);
    const htmlA = await resA.text();
    const extractedA = extract4KHDHubLinks(htmlA, `${baseUrl}/movie-a`);

    const resB = await fetch(`${baseUrl}/movie-b`);
    const htmlB = await resB.text();
    const extractedB = extract4KHDHubLinks(htmlB, `${baseUrl}/movie-b`);

    expect(extractedA.links[0].mediatorUrl).not.toEqual(extractedB.links[0].mediatorUrl);
    expect(extractedB.links[0].mediatorUrl).toContain('different_mediator_999');
    expect(extractedB.title).toContain('Oppenheimer');
  });

  // Test C — different quality
  it('Test C: Different qualities (2160p, 1080p, 720p) do not get mixed', async () => {
    const res = await fetch(`${baseUrl}/multi-quality`);
    const html = await res.text();
    const extracted = extract4KHDHubLinks(html, `${baseUrl}/multi-quality`);

    expect(extracted.links.length).toBe(3);

    const q2160 = extracted.links.find((l) => l.quality === '2160p');
    const q1080 = extracted.links.find((l) => l.quality === '1080p');
    const q720 = extracted.links.find((l) => l.quality === '720p');

    expect(q2160).toBeDefined();
    expect(q1080).toBeDefined();
    expect(q720).toBeDefined();

    expect(q2160.mediatorUrl).toContain('q=2160');
    expect(q1080.mediatorUrl).toContain('q=1080');
    expect(q720.mediatorUrl).toContain('q=720');
  });

  // Test D — multiple episodes
  it('Test D: Multiple episodes remain associated with their respective episodes', async () => {
    const res = await fetch(`${baseUrl}/series-episodes`);
    const html = await res.text();
    const extracted = extract4KHDHubLinks(html, `${baseUrl}/series-episodes`);

    expect(extracted.links.length).toBe(2);

    const ep1 = extracted.links.find((l) => l.episode === 1);
    const ep2 = extracted.links.find((l) => l.episode === 2);

    expect(ep1).toBeDefined();
    expect(ep1.season).toBe(2);
    expect(ep1.mediatorUrl).toContain('ep=1');

    expect(ep2).toBeDefined();
    expect(ep2.season).toBe(2);
    expect(ep2.mediatorUrl).toContain('ep=2');
  });

  // Test E — mediator URL changes
  it('Test E: Dynamically handles changing mediator URLs without requiring code changes', async () => {
    const dynamicMediatorUrl = `${baseUrl}/mediator-countdown?token=rand_${Date.now()}`;
    const syntheticHtml = `
      <h1>Random Release</h1>
      <div>
        <p>1080p Web-DL</p>
        <a href="${dynamicMediatorUrl}">Download HubCloud</a>
      </div>
    `;

    const extracted = extract4KHDHubLinks(syntheticHtml);
    expect(extracted.links[0].mediatorUrl).toBe(dynamicMediatorUrl);

    const resolution = await resolveMediatorFlow(extracted.links[0].mediatorUrl, {
      countdownTimeout: 5000,
    });
    expect(resolution.success).toBe(true);
    expect(isHubCloudDriveUrl(resolution.destination)).toBe(true);
  }, 15000);

  // Test F — CAPTCHA appears
  it('Test F: Stops and returns CAPTCHA_REQUIRED without attempting bypass when challenge appears', async () => {
    const captchaMediatorUrl = `${baseUrl}/mediator-captcha`;

    const resolution = await resolveMediatorFlow(captchaMediatorUrl, {
      countdownTimeout: 3000,
    });

    expect(resolution.success).toBe(false);
    expect(resolution.state).toBe(STATES.CAPTCHA_REQUIRED);
    expect(resolution.error).toContain('Human verification');
  });

  // Test G — destination unavailable
  it('Test G: Returns HUBCLOUD_DESTINATION_NOT_FOUND when navigation does not yield HubCloud drive URL', async () => {
    const invalidMediatorUrl = `${baseUrl}/mediator-invalid-dest`;

    const resolution = await resolveMediatorFlow(invalidMediatorUrl, {
      countdownTimeout: 2000,
      navigationTimeout: 1000,
    });

    expect(resolution.success).toBe(false);
    expect(resolution.state).toBe(STATES.HUBCLOUD_DESTINATION_NOT_FOUND);
  }, 15000);

  // ResolverService integration test with caching and targeting
  it('ResolverService handles targetQuality filtering and caching', async () => {
    const service = new ResolverService({ maxRetries: 1 });

    const result = await service.resolveSource({
      url: `${baseUrl}/multi-quality`,
      targetQuality: '2160p',
      resolveMediators: false,
    });

    expect(result.links.length).toBe(1);
    expect(result.links[0].quality).toBe('2160p');
    expect(result.links[0].mediatorUrl).toContain('q=2160');
  });

  it('fetchHubCloudMetadata rejects non-hubcloud URLs and returns null gracefully', async () => {
    expect(await fetchHubCloudMetadata('https://example.com/movie')).toBe(null);
    expect(await fetchHubCloudMetadata('https://hubcloud.ist/invalid-path')).toBe(null);
    expect(await fetchHubCloudMetadata(null)).toBe(null);
  });

  it('detectContentTypeFromUrl correctly identifies movies vs series from URL semantics', () => {
    expect(detectContentTypeFromUrl('https://4khdhub.one/unabomber-movie-8202/')).toBe('movie');
    expect(detectContentTypeFromUrl('https://4khdhub.one/unabomber-movie-8202')).toBe('movie');
    expect(detectContentTypeFromUrl('https://4khdhub.one/mobland-series-98/')).toBe('series');
    expect(detectContentTypeFromUrl('https://4khdhub.one/mobland-series-98')).toBe('series');
    expect(detectContentTypeFromUrl('https://sample-movies.org/movies/avatar-3/')).toBe('movie');
    expect(detectContentTypeFromUrl('https://sample-series.org/series/loki-season-2/')).toBe('series');
    expect(detectContentTypeFromUrl('https://example.com/random-page')).toBe(null);
  });

  it('Movie URL forces scope to movie and strips season/episode numbers', () => {
    const syntheticMovieHtml = `
      <h1>UNABOMBER (2026)</h1>
      <div id="content-file-1">
        <h4 class="file-title">UNABOMBER.2026.2160p.REPACK.NF.WEB-DL.MULTi.DDP5.1.Atmos.DV.HDR.H.265-4kHdHub.Com.mkv</h4>
        <a href="https://example.com/med1">Download HubCloud</a>
      </div>
      <div id="content-file-2">
        <h4 class="file-title">UNABOMBER.2026.1080p.NF.WEB-DL.Multi.DDP5.1.Atmos.H.264-4kHdHub.Com.mkv</h4>
        <a href="https://example.com/med2">Download HubCloud</a>
      </div>
    `;

    const result = extract4KHDHubLinks(syntheticMovieHtml, 'https://4khdhub.one/unabomber-movie-8202/');
    expect(result.contentType).toBe('movie');
    expect(result.links.length).toBe(2);
    expect(result.links[0].scope).toBe('movie');
    expect(result.links[0].season).toBe(null);
    expect(result.links[0].episode).toBe(null);
    expect(result.links[1].scope).toBe('movie');
    expect(result.links[1].season).toBe(null);
    expect(result.links[1].episode).toBe(null);
  });

  it('Series URL properly separates complete season packs from individual episodes', () => {
    const syntheticSeriesHtml = `
      <h1>MobLand (Season 1)</h1>
      <div id="complete-pack">
        <h4 class="file-title">MobLand.S01.Complete.Zip.Pack.1080p</h4>
        <a href="https://example.com/med-pack">Download HubCloud</a>
      </div>
      <div id="episodes">
        <div class="episode-download-item">
          <span class="badge">Episode-01</span>
          <h4 class="file-title">MobLand.S01E01.1080p</h4>
          <a href="https://example.com/med-ep1">Download HubCloud</a>
        </div>
      </div>
    `;

    const result = extract4KHDHubLinks(syntheticSeriesHtml, 'https://4khdhub.one/mobland-series-98/');
    expect(result.contentType).toBe('series');
    expect(result.links.length).toBe(2);

    const pack = result.links.find((l) => l.scope === 'pack');
    const ep = result.links.find((l) => l.scope === 'episode');

    expect(pack).toBeDefined();
    expect(pack.scope).toBe('pack');
    expect(pack.season).toBe(1);

    expect(ep).toBeDefined();
    expect(ep.scope).toBe('episode');
    expect(ep.season).toBe(1);
    expect(ep.episode).toBe(1);
  });
});
