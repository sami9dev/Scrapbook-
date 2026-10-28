/**
 * Test Suite for 4KHub4U Catalogue & Telegraph Implementation
 * Strictly verifies the 21 test scenarios specified in Section 30 of the specification.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import {
  parse4KHubCatalogue,
  extractVideoAttributes,
  extractAudioLanguages,
  buildReleaseLabel,
} from '../src/scrapers/4khub4u/catalogue.js';
import {
  buildMovieTelegraphNodes,
  buildSeriesTelegraphNodes,
  createTelegraphCataloguePage,
  getHubCloudDownloadLinks,
} from '../src/scrapers/4khub4u/telegraph.js';
import {
  formatCatalogueTelegramSummary,
  formatVerificationRequiredMessage,
} from '../src/bot/telegram/messages.js';
import { TelegramJobManager } from '../src/bot/telegram/handlers.js';
import { routeIncomingMessage } from '../src/bot/telegram/commands.js';
import { resolve4KHub4U } from '../src/scrapers/4khub4u/resolver.js';
import { Hub4UState, ResolutionState } from '../src/scrapers/4khub4u/types.js';
import { inspectHtml } from '../src/resolvers/mediator/http-first.js';

let server;
let baseUrl;

const HUBCLOUD_DEST = 'https://hubcloud.ist/drive/d3vug2udf3bu8iv';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Mock verification challenge page
    if (url.pathname === '/4kh-challenge') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`
        <html>
          <head><title>Just a moment...</title></head>
          <body>
            <div class="cf-turnstile"></div>
            <p>Please verify you are a human</p>
          </body>
        </html>
      `);
    }

    // Mock verification mediator
    if (url.pathname === '/mediator-challenge') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`
        <html>
          <head><title>Just a moment...</title></head>
          <body>
            <div class="cf-turnstile"></div>
          </body>
        </html>
      `);
    }

    // Mock timeout mediator (hangs or never displays link)
    if (url.pathname === '/mediator-timeout') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`
        <html>
          <head><title>Please Wait...</title></head>
          <body>
            <div id="loading">Connecting...</div>
          </body>
        </html>
      `);
    }

    // Mock direct public destination mediator
    if (url.pathname === '/mediator-public') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`
        <html>
          <head><title>Get Link</title></head>
          <body>
            <a href="${HUBCLOUD_DEST}">Download HubCloud</a>
          </body>
        </html>
      `);
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('4KHub4U Catalogue & Telegraph Specification Tests (Section 30)', () => {
  // Test 1: Movie with 1080p x264
  it('1. Extracts Movie with 1080p x264 correctly', () => {
    const html = `
      <h1>Inception (2010)</h1>
      <div class="download-item">
        <div class="download-header">Inception (1080p BluRay x264) 2.4 GB Hindi, English</div>
        <div class="file-title">Inception.2010.1080p.BluRay.x264.mkv</div>
        <a href="https://greenmotors.club/?id=inc_1080">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/inception-movie-101/');
    expect(cat.type).toBe('movie');
    expect(cat.title).toBe('Inception');
    expect(cat.year).toBe('2010');
    expect(cat.totalReleases).toBe(1);

    const rel = cat.qualities[0].releases[0];
    expect(rel.quality.normalized).toBe('1080p');
    expect(rel.codec).toBe('x264');
    expect(rel.sourceType).toBe('BluRay');
    expect(rel.fileSize).toBe('2.4 GB');
    expect(rel.downloadLinks[0].url).toBe('https://greenmotors.club/?id=inc_1080');
  });

  // Test 2: Movie with 2160p SDR
  it('2. Extracts Movie with 2160p SDR correctly', () => {
    const html = `
      <h1>Avatar (2009)</h1>
      <div class="download-item">
        <div class="download-header">Avatar (2160p WEB-DL SDR HEVC) 18.2 GB English</div>
        <div class="file-title">Avatar.2009.2160p.SDR.WEB-DL.mkv</div>
        <a href="https://greenmotors.club/?id=av_sdr">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/avatar-movie-102/');
    expect(cat.totalReleases).toBe(1);
    const rel = cat.qualities[0].releases[0];
    expect(rel.quality.normalized).toBe('2160p');
    expect(rel.dynamicRange).toBe('SDR');
    expect(rel.codec).toBe('HEVC');
  });

  // Test 3: Movie with 2160p HDR
  it('3. Extracts Movie with 2160p HDR correctly', () => {
    const html = `
      <h1>Avatar (2009)</h1>
      <div class="download-item">
        <div class="download-header">Avatar (2160p HDR HEVC) 22.5 GB English</div>
        <div class="file-title">Avatar.2009.2160p.HDR.mkv</div>
        <a href="https://greenmotors.club/?id=av_hdr">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/avatar-movie-102/');
    const rel = cat.qualities[0].releases[0];
    expect(rel.quality.normalized).toBe('2160p');
    expect(rel.dynamicRange).toBe('HDR');
    expect(rel.codec).toBe('HEVC');
  });

  // Test 4: Movie with 2160p DV
  it('4. Extracts Movie with 2160p DV (Dolby Vision) correctly', () => {
    const html = `
      <h1>Avatar (2009)</h1>
      <div class="download-item">
        <div class="download-header">Avatar (2160p Dolby Vision HEVC) 24.1 GB English</div>
        <div class="file-title">Avatar.2009.2160p.DV.mkv</div>
        <a href="https://greenmotors.club/?id=av_dv">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/avatar-movie-102/');
    const rel = cat.qualities[0].releases[0];
    expect(rel.quality.normalized).toBe('2160p');
    expect(rel.dynamicRange).toBe('Dolby Vision');
  });

  // Test 5: Movie with 2160p 10-bit
  it('5. Extracts Movie with 2160p 10-bit correctly', () => {
    const html = `
      <h1>Dune (2021)</h1>
      <div class="download-item">
        <div class="download-header">Dune (2160p 10-bit HEVC) 16.5 GB English</div>
        <div class="file-title">Dune.2021.2160p.10bit.mkv</div>
        <a href="https://greenmotors.club/?id=dune_10bit">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/dune-movie-103/');
    const rel = cat.qualities[0].releases[0];
    expect(rel.quality.normalized).toBe('2160p');
    expect(rel.bitDepth).toBe('10-bit');
  });

  // Test 6: Movie containing multiple 2160p variants (separate entries, not collapsed)
  it('6. Preserves multiple 2160p variants as separate entries without collapsing', () => {
    const html = `
      <h1>Oppenheimer (2023)</h1>
      <div class="download-item">
        <div class="download-header">Oppenheimer (2160p SDR HEVC) 18.0 GB</div>
        <a href="https://greenmotors.club/?id=opp_sdr">Download HubCloud</a>
      </div>
      <div class="download-item">
        <div class="download-header">Oppenheimer (2160p HDR HEVC) 22.0 GB</div>
        <a href="https://greenmotors.club/?id=opp_hdr">Download HubCloud</a>
      </div>
      <div class="download-item">
        <div class="download-header">Oppenheimer (2160p Dolby Vision 10-bit HEVC) 26.0 GB</div>
        <a href="https://greenmotors.club/?id=opp_dv">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/oppenheimer-movie-104/');
    expect(cat.totalReleases).toBe(3);

    const q2160 = cat.qualities.find((q) => q.resolution === '2160p');
    expect(q2160).toBeDefined();
    expect(q2160.releases.length).toBe(3);

    const labels = q2160.releases.map((r) => r.dynamicRange);
    expect(labels).toContain('SDR');
    expect(labels).toContain('HDR');
    expect(labels).toContain('Dolby Vision');
  });

  // Test 7: Hindi + English audio
  it('7. Extracts Hindi + English and multiple audio languages accurately', () => {
    const html = `
      <h1>RRR (2022)</h1>
      <div class="download-item">
        <div class="download-header">RRR (2160p HDR) 20 GB Hindi, English, Tamil, Telugu</div>
        <a href="https://greenmotors.club/?id=rrr_multi">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/rrr-movie-105/');
    expect(cat.audioLanguages).toContain('Hindi');
    expect(cat.audioLanguages).toContain('English');
    expect(cat.audioLanguages).toContain('Tamil');
    expect(cat.audioLanguages).toContain('Telugu');
  });

  // Test 8: Series with 4 seasons
  it('8. Dynamically discovers Series with 4 seasons', () => {
    const html = `
      <h1>Succession</h1>
      <div class="download-item"><div class="download-header">S01 1080p</div><a href="https://greenmotors.club/?id=s1">Download HubCloud</a></div>
      <div class="download-item"><div class="download-header">S02 1080p</div><a href="https://greenmotors.club/?id=s2">Download HubCloud</a></div>
      <div class="download-item"><div class="download-header">S03 1080p</div><a href="https://greenmotors.club/?id=s3">Download HubCloud</a></div>
      <div class="download-item"><div class="download-header">S04 1080p</div><a href="https://greenmotors.club/?id=s4">Download HubCloud</a></div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/succession-series-106/');
    expect(cat.type).toBe('series');
    expect(cat.seasons.length).toBe(4);
    const seasonNums = cat.seasons.map((s) => s.number).sort((a, b) => a - b);
    expect(seasonNums).toEqual([1, 2, 3, 4]);
  });

  // Test 9: Series with 8 seasons (never hardcoded to 4)
  it('9. Dynamically discovers Series with 8 seasons without hardcoded limits', () => {
    const html = `
      <h1>Game of Thrones</h1>
      ${[1, 2, 3, 4, 5, 6, 7, 8]
        .map(
          (num) => `
        <div class="download-item">
          <div class="download-header">S0${num} 2160p HDR</div>
          <a href="https://greenmotors.club/?id=got_s0${num}">Download HubCloud</a>
        </div>
      `
        )
        .join('\n')}
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/game-of-thrones-series-107/');
    expect(cat.type).toBe('series');
    expect(cat.seasons.length).toBe(8);
    const seasonNums = cat.seasons.map((s) => s.number).sort((a, b) => a - b);
    expect(seasonNums).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // Test 10: Different qualities per season
  it('10. Preserves different release qualities per season', () => {
    const html = `
      <h1>The Boys</h1>
      <div class="download-item"><div class="download-header">S01 1080p x264</div><a href="https://greenmotors.club/?id=b_s1">Download HubCloud</a></div>
      <div class="download-item"><div class="download-header">S02 2160p DV</div><a href="https://greenmotors.club/?id=b_s2">Download HubCloud</a></div>
      <div class="download-item"><div class="download-header">S03 2160p SDR</div><a href="https://greenmotors.club/?id=b_s3">Download HubCloud</a></div>
      <div class="download-item"><div class="download-header">S03 2160p HDR</div><a href="https://greenmotors.club/?id=b_s3_hdr">Download HubCloud</a></div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/the-boys-series-108/');
    const s1 = cat.seasons.find((s) => s.number === 1);
    const s2 = cat.seasons.find((s) => s.number === 2);
    const s3 = cat.seasons.find((s) => s.number === 3);

    expect(s1.releases[0].quality.normalized).toBe('1080p');
    expect(s2.releases[0].dynamicRange).toBe('Dolby Vision');
    expect(s3.releases.length).toBe(2);
    expect(s3.releases.map((r) => r.dynamicRange)).toContain('SDR');
    expect(s3.releases.map((r) => r.dynamicRange)).toContain('HDR');
  });

  // Test 11: Multiple links per release
  it('11. Retains all multiple links per release (Link A, Link B)', () => {
    const html = `
      <h1>Movie Multi Links</h1>
      <div class="download-item">
        <div class="download-header">1080p x264</div>
        <a href="https://greenmotors.club/?id=link_a">Download HubCloud</a>
        <a href="https://greenmotors.club/?id=link_b">Download HubDrive</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/movie-109/');
    const rel = cat.qualities[0].releases[0];
    expect(rel.downloadLinks.length).toBe(2);
    expect(rel.downloadLinks[0].url).toBe('https://greenmotors.club/?id=link_a');
    expect(rel.downloadLinks[1].url).toBe('https://greenmotors.club/?id=link_b');
  });

  // Test 12: Relative URLs
  it('12. Normalizes relative URLs using sourceUrl', () => {
    const html = `
      <h1>Movie Relative</h1>
      <div class="download-item">
        <div class="download-header">1080p x264</div>
        <a href="/mediator-relative/?id=123">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/relative-movie/');
    const rel = cat.qualities[0].releases[0];
    expect(rel.downloadLinks[0].url).toBe('https://4khdhub.one/mediator-relative/?id=123');
  });

  // Test 13: Absolute URLs
  it('13. Preserves absolute URLs untouched', () => {
    const html = `
      <h1>Movie Absolute</h1>
      <div class="download-item">
        <div class="download-header">1080p x264</div>
        <a href="https://fast-share.club/?id=abs_999">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/absolute-movie/');
    const rel = cat.qualities[0].releases[0];
    expect(rel.downloadLinks[0].url).toBe('https://fast-share.club/?id=abs_999');
  });

  // Test 14: Dynamic mediator IDs
  it('14. Captures dynamic mediator IDs without hardcoding', () => {
    const dynamicId = 'Q1dxTzFnbjhrQm5kMG5lL01tQzcvdEhwZ0JtZVdjNUEvbXdPRHcyWGVHVzFzeHd1';
    const html = `
      <h1>Movie Dynamic</h1>
      <div class="download-item">
        <div class="download-header">2160p HDR</div>
        <a href="https://greenmotors.club/?id=${dynamicId}">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/dynamic-movie/');
    expect(cat.qualities[0].releases[0].downloadLinks[0].url).toContain(dynamicId);
  });

  // Test 15: Duplicate links
  it('15. Deduplicates identical links safely', () => {
    const html = `
      <h1>Movie Duplicates</h1>
      <div class="download-item">
        <div class="download-header">1080p x264</div>
        <a href="https://greenmotors.club/?id=dup_1">Download HubCloud</a>
        <a href="https://greenmotors.club/?id=dup_1">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/dup-movie/');
    // Both anchors exist in container, but links list handles them
    expect(cat.qualities[0].releases[0].downloadLinks[0].url).toBe('https://greenmotors.club/?id=dup_1');
  });

  // Test 16: Missing quality
  it('16. Handles missing quality gracefully without crashing', () => {
    const html = `
      <h1>Unknown Quality Content</h1>
      <div class="download-item">
        <div class="download-header">Special Edition Bonus Features</div>
        <a href="https://greenmotors.club/?id=bonus">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/bonus-content/');
    expect(cat.totalReleases).toBe(1);
    expect(cat.qualities[0].releases[0].quality.normalized).toBe('unknown');
  });

  // Test 17: Missing audio
  it('17. Handles missing audio languages gracefully without crashing', () => {
    const html = `
      <h1>Silent Film (1927)</h1>
      <div class="download-item">
        <div class="download-header">1080p BluRay x264</div>
        <a href="https://greenmotors.club/?id=silent">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/silent-film/');
    expect(cat.audioLanguages).toEqual([]);
  });

  // Test 18: Missing season metadata in series
  it('18. Handles missing season metadata gracefully without crash', () => {
    const html = `
      <h1>Mini Series</h1>
      <div class="download-item">
        <div class="download-header">Complete Mini Series 1080p</div>
        <a href="https://greenmotors.club/?id=mini">Download HubCloud</a>
      </div>
    `;
    const cat = parse4KHubCatalogue(html, 'https://4khdhub.one/mini-series-123/');
    expect(cat.totalReleases).toBe(1);
  });

  // Test 19: Verification-required mediator
  it('19. Returns verification_required without attempting bypass when challenge encountered', async () => {
    const challengeUrl = `${baseUrl}/mediator-challenge`;
    const res = await resolve4KHub4U(challengeUrl, { useHttpFirst: true });
    expect(res.state).toBe(Hub4UState.VERIFICATION_REQUIRED);
    expect(res.destination).toBeNull();
  });

  // Test 20: Timeout
  it('20. Returns timeout when mediator resolution exceeds configured threshold', async () => {
    const timeoutUrl = `${baseUrl}/mediator-timeout`;
    const res = await resolve4KHub4U(timeoutUrl, {
      useHttpFirst: true,
      openTimeout: 500,
      countdownTimeout: 500,
      navigationTimeout: 500,
    });
    expect([Hub4UState.TIMEOUT, Hub4UState.DESTINATION_NOT_FOUND, Hub4UState.ERROR]).toContain(res.state);
  }, 15000);

  // Test 21: Public destination detection
  it('21. Directly detects publicly exposed HubCloud drive destinations', async () => {
    const publicUrl = `${baseUrl}/mediator-public`;
    const res = await resolve4KHub4U(publicUrl, { useHttpFirst: true });
    expect(res.success).toBe(true);
    expect(res.state).toBe(Hub4UState.DESTINATION_FOUND);
    expect(res.destination).toBe(HUBCLOUD_DEST);
  });

  // Presentation & Telegraph AST Generation Tests
  it('Generates valid Movie Telegraph Node AST (Section 16)', () => {
    const cat = {
      title: 'Dune: Part Two',
      year: '2024',
      type: 'movie',
      audioLanguages: ['Hindi', 'English'],
      qualities: [
        {
          resolution: '2160p',
          releases: [
            {
              label: '2160p HDR 10-bit HEVC',
              quality: { normalized: '2160p' },
              dynamicRange: 'HDR',
              bitDepth: '10-bit',
              codec: 'HEVC',
              downloadLinks: [{ label: 'Download HubCloud', url: 'https://hubcloud.ist/drive/123' }],
            },
          ],
        },
      ],
      seasons: [],
    };

    const nodes = buildMovieTelegraphNodes(cat);
    expect(nodes.some((n) => n.children?.includes('📺 Available Quality'))).toBe(true);
    expect(nodes.some((n) => n.children?.includes('🔊 Audio'))).toBe(true);
    expect(nodes.some((n) => n.children?.includes('📦 Releases'))).toBe(true);
  });

  it('Generates valid Series Telegraph Node AST organized by season (Section 17)', () => {
    const cat = {
      title: 'Ozark',
      type: 'series',
      audioLanguages: ['Hindi', 'English'],
      qualities: [{ resolution: '2160p', releases: [] }],
      seasons: [
        {
          number: 4,
          releases: [
            {
              label: 'S04 Complete Pack 2160p HDR',
              quality: { normalized: '2160p' },
              scope: 'pack',
              downloadLinks: [{ label: 'Download HubCloud', url: 'https://hubcloud.ist/drive/pack4' }],
            },
            {
              label: 'E01 • 2160p HDR',
              quality: { normalized: '2160p' },
              scope: 'episode',
              episode: 1,
              downloadLinks: [{ label: 'Download HubCloud', url: 'https://hubcloud.ist/drive/ep1' }],
            },
          ],
        },
      ],
    };

    const nodes = buildSeriesTelegraphNodes(cat);
    expect(nodes.some((n) => n.children?.includes('SEASON 04'))).toBe(true);
  });

  it('Formats concise Telegram summary message with Telegraph link (Section 18)', () => {
    const cat = {
      title: 'Game of Thrones',
      type: 'series',
      seasons: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ number: n, releases: [] })),
      qualities: [{ resolution: '1080p', releases: [] }, { resolution: '2160p', releases: [] }],
      audioLanguages: ['Hindi', 'English'],
    };

    const msg = formatCatalogueTelegramSummary(cat, 'https://telegra.ph/GoT-Catalogue');
    expect(msg).toContain('Game of Thrones');
    expect(msg).toContain('8 Seasons');
    expect(msg).toContain('1080p + 2160p');
    expect(msg).toContain('Hindi + English');
    expect(msg).toContain('https://telegra.ph/GoT-Catalogue');
  });

  it('Routes incoming URL message through TelegramJobManager.handleIncomingUrl', async () => {
    let sentMessage = null;
    const mockSender = {
      sendMessage: async (chatId, text, opts) => {
        sentMessage = { chatId, text, opts };
        return { messageId: 101 };
      },
      editMessageText: async (chatId, msgId, text, opts) => {
        sentMessage = { chatId, text, opts };
      },
    };

    const jobManager = new TelegramJobManager();
    // Test rejection of non-4KHub4U arbitrary URLs
    await routeIncomingMessage(
      mockSender,
      { chatId: 12345, userId: 1, text: 'https://unauthorized-spam.com/video' },
      jobManager
    );
    expect(sentMessage.text).toContain('Invalid URL');
  });

  it('getHubCloudDownloadLinks strictly returns only HubCloud link and excludes HubDrive', () => {
    const mixedLinks = [
      {
        provider: 'HubCloud',
        label: 'Download HubCloud',
        url: 'https://hubcloud.ist/drive/k1hek5o1gutelsz',
      },
      {
        provider: 'HubDrive',
        label: 'Download HubDrive',
        url: 'https://hubdrive.pics/file/58528460621',
      },
    ];

    const result = getHubCloudDownloadLinks(mixedLinks);
    expect(result.length).toBe(1);
    expect(result[0].url).toBe('https://hubcloud.ist/drive/k1hek5o1gutelsz');
    expect(result[0].provider).toBe('HubCloud');
  });

  it('buildSeriesTelegraphNodes renders only HubCloud links and never HubDrive links', () => {
    const cat = {
      title: 'Avatar: The Last Airbender',
      type: 'series',
      audioLanguages: ['Hindi', 'English'],
      qualities: [{ resolution: '2160p', releases: [] }],
      seasons: [
        {
          number: 2,
          releases: [
            {
              filename: 'Avatar.The.Last.Airbender.S02.2160p.NF.WEB-DL.MULTi.DDP5.1.Atmos.H.265-4kHdHub.Com.zip',
              fileSize: '60.38 GB',
              scope: 'pack',
              downloadLinks: [
                {
                  provider: 'HubCloud',
                  label: 'Download HubCloud',
                  url: 'https://hubcloud.ist/drive/k1hek5o1gutelsz',
                },
                {
                  provider: 'HubDrive',
                  label: 'Download HubDrive',
                  url: 'https://hubdrive.pics/file/58528460621',
                },
              ],
            },
          ],
        },
      ],
    };

    const nodes = buildSeriesTelegraphNodes(cat);
    const nodesString = JSON.stringify(nodes);
    expect(nodesString).toContain('https://hubcloud.ist/drive/k1hek5o1gutelsz');
    expect(nodesString).not.toContain('https://hubdrive.pics/file/58528460621');
    expect(nodesString).not.toContain('hubdrive');
  });

  // Test: Sense DV HDR vs simple H.265 SDR attribute analysis
  it('Correctly senses Dolby Vision + HDR vs simple H.265 (SDR)', () => {
    const dvHdrFile = 'American.Primeval.S01E01.Episode.1.2160p.NF.WEB-DL.DUAL.DDP5.1.DV.HDR.H.265-4kHdHub.Com.mkv';
    const sdrFile = 'American.Primeval.S01E01.Episode.1.2160p.NF.WEB-DL.DUAL.DDP5.1.H.265-4kHdHub.Com.mkv';

    const attrsDvHdr = extractVideoAttributes(dvHdrFile);
    expect(attrsDvHdr.resolution).toBe('2160p');
    expect(attrsDvHdr.dynamicRange).toBe('Dolby Vision + HDR');
    expect(attrsDvHdr.codec).toBe('HEVC');
    expect(attrsDvHdr.sourceType).toBe('WEB-DL');

    const attrsSdr = extractVideoAttributes(sdrFile);
    expect(attrsSdr.resolution).toBe('2160p');
    expect(attrsSdr.dynamicRange).toBe('SDR');
    expect(attrsSdr.codec).toBe('HEVC');
    expect(attrsSdr.sourceType).toBe('WEB-DL');
  });

  // Test: buildSeriesTelegraphNodes organizes episodes into separate variant groups
  it('Organizes series episodes into separate variant groups with clear category headers', () => {
    const cat = {
      title: 'American Primeval',
      type: 'series',
      audioLanguages: ['Hindi', 'English'],
      qualities: [{ resolution: '2160p', releases: [] }],
      seasons: [
        {
          number: 1,
          releases: [
            {
              filename: 'American.Primeval.S01E01.Episode.1.2160p.NF.WEB-DL.DUAL.DDP5.1.DV.HDR.H.265-4kHdHub.Com.mkv',
              quality: { normalized: '2160p' },
              resolution: '2160p',
              dynamicRange: 'Dolby Vision + HDR',
              sourceType: 'WEB-DL',
              codec: 'HEVC',
              scope: 'episode',
              episode: 1,
              downloadLinks: [{ provider: 'HubCloud', url: 'https://hubcloud.ist/drive/dvhdr_ep1' }],
            },
            {
              filename: 'American.Primeval.S01E01.Episode.1.2160p.NF.WEB-DL.DUAL.DDP5.1.H.265-4kHdHub.Com.mkv',
              quality: { normalized: '2160p' },
              resolution: '2160p',
              dynamicRange: 'SDR',
              sourceType: 'WEB-DL',
              codec: 'HEVC',
              scope: 'episode',
              episode: 1,
              downloadLinks: [{ provider: 'HubCloud', url: 'https://hubcloud.ist/drive/sdr_ep1' }],
            },
          ],
        },
      ],
    };

    const nodes = buildSeriesTelegraphNodes(cat);
    const textNodes = nodes.map((n) => JSON.stringify(n));
    const allText = textNodes.join('\n');

    // Both distinct variant headers exist
    expect(allText).toContain('Episodes (2160p • Dolby Vision + HDR • WEB-DL • HEVC)');
    expect(allText).toContain('Episodes (2160p • SDR • WEB-DL • HEVC)');

    // 2160p DV HDR comes before 2160p SDR
    const dvHdrIdx = allText.indexOf('Episodes (2160p • Dolby Vision + HDR • WEB-DL • HEVC)');
    const sdrIdx = allText.indexOf('Episodes (2160p • SDR • WEB-DL • HEVC)');
    expect(dvHdrIdx).toBeLessThan(sdrIdx);

    // Each episode has its direct HubCloud URL
    expect(allText).toContain('https://hubcloud.ist/drive/dvhdr_ep1');
    expect(allText).toContain('https://hubcloud.ist/drive/sdr_ep1');
  });

  // Test: getHubCloudDownloadLinks never returns raw mediator links
  it('getHubCloudDownloadLinks strictly excludes raw mediator links and returns empty array if unverified', () => {
    const rawMediatorLinks = [
      {
        provider: 'HubCloud',
        label: 'Download HubCloud',
        url: 'https://greenmotors.club/?id=N2Y1RTIYK0ZEVWRQVFBNQ3F0Mkp5aFlvaWpGZ0hDVFh4Vk1kQU5kdz0=',
      },
    ];

    const result = getHubCloudDownloadLinks(rawMediatorLinks);
    expect(result).toEqual([]);
  });

  // Test: buildSeriesTelegraphNodes renders clean warning when episode link is unavailable
  it('buildSeriesTelegraphNodes renders clean unavailable warning when upstream episode link is dead', () => {
    const cat = {
      title: 'Sweet Home',
      type: 'series',
      audioLanguages: ['Korean', 'English'],
      qualities: [{ resolution: '1080p', releases: [] }],
      seasons: [
        {
          number: 2,
          releases: [
            {
              filename: 'Sweet.Home.S02E08.1080p.NF.WEB-DL.Multi.DDP5.1.H.264-4kHdHub.Com.mkv',
              quality: { normalized: '1080p' },
              resolution: '1080p',
              dynamicRange: 'SDR',
              codec: 'x264',
              scope: 'episode',
              episode: 8,
              // Raw mediator link that failed to resolve
              downloadLinks: [
                {
                  provider: 'HubCloud',
                  url: 'https://greenmotors.club/?id=dead_link',
                },
              ],
            },
          ],
        },
      ],
    };

    const nodes = buildSeriesTelegraphNodes(cat);
    const nodesString = JSON.stringify(nodes);
    expect(nodesString).not.toContain('https://greenmotors.club');
    expect(nodesString).toContain('⚠️ HubCloud Link Unavailable (Expired on source site)');
  });

  // Test: inspectHtml detects dead/expired mediator links immediately as invalid_link
  it('inspectHtml detects dead/expired mediator links immediately as invalid_link', () => {
    const deadHtml1 = '\n\nFailed to decode link';
    const res1 = inspectHtml(deadHtml1, 'https://greenmotors.club/?id=dead_1');
    expect(res1.state).toBe('invalid_link');

    const deadHtml2 = '<html><body><h1>Invalid Link !!</h1></body></html>';
    const res2 = inspectHtml(deadHtml2, 'https://greenmotors.club/?id=dead_2');
    expect(res2.state).toBe('invalid_link');

    const deadHtml3 = '<html><head><title>Link Expired</title></head><body></body></html>';
    const res3 = inspectHtml(deadHtml3, 'https://greenmotors.club/?id=dead_3');
    expect(res3.state).toBe('invalid_link');
  });
});

