import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSourcePage } from '../src/sources/source-parser.js';
import { providerRegistry } from '../src/providers/provider-registry.js';
import { extractGdflixFileId, parseGdflix } from '../src/providers/gdflix.js';
import { discoverExposedDestination, extractOpaqueToken } from '../src/discovery/link-discovery.js';
import { parseFilenameMetadata } from '../src/parsing/metadata-parser.js';
import { parseSizeToBytes, normalizeSize } from '../src/utils/normalize.js';
import { extractMirrors } from '../src/parsing/mirror-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '../fixtures');

describe('Phase 2: Source Page & Provider Detection', () => {
  it('extracts metadata and resolves relative links against page origin', () => {
    const html = fs.readFileSync(path.join(fixturesDir, 'source-page.html'), 'utf-8');
    const sourceUrl = 'https://example-authorized-site.test/tvshows/example-show/';

    const result = parseSourcePage(html, sourceUrl);

    expect(result.title).toBe('Example Show');
    expect(result.year).toBe(2026);
    expect(result.type).toBe('tv');
    expect(result.season).toBe(1);
    expect(result.quality).toBe('2160p');
    expect(result.codec).toBe('H.265');
    expect(result.audio).toContain('DDPA');
    expect(result.audio).toContain('Atmos');
    expect(result.languages).toContain('MULTI');
    expect(result.sizeDisplay).toBe('39.47 GB');

    // Section 3: /some/path with text "G" must be resolved against origin
    const relativeLink = result.discoveredLinks.find((l) => l.rawHref === '/some/path');
    expect(relativeLink).toBeDefined();
    expect(relativeLink.resolvedUrl).toBe('https://example-authorized-site.test/some/path');
    expect(relativeLink.buttonText).toBe('G');
    // Crucially: does NOT assume single letter "G" is the provider name
    expect(relativeLink.provider).not.toBe('G');
  });

  it('detects registered provider links in source page', () => {
    const html = fs.readFileSync(path.join(fixturesDir, 'source-page.html'), 'utf-8');
    const sourceUrl = 'https://example-authorized-site.test/tvshows/example-show/';

    const result = parseSourcePage(html, sourceUrl);
    const gdflixLink = result.discoveredLinks.find((l) => l.resolvedUrl.includes('gdflix.example'));
    expect(gdflixLink).toBeDefined();
    expect(gdflixLink.provider).toBe('GDFLIX');
  });

  it('allows registering new providers dynamically without modifying core code', () => {
    providerRegistry.register({
      name: 'CUSTOM_HOST',
      domains: ['custom-storage.example'],
      parser: async () => ({ provider: 'CUSTOM_HOST' }),
    });

    const found = providerRegistry.findProvider('https://custom-storage.example/d/xyz123');
    expect(found).toBeDefined();
    expect(found.name).toBe('CUSTOM_HOST');
  });

  it('extracts rowTitle and per-card episode/quality metadata from .cmz-row-card', () => {
    const cardHtml = `
      <html>
        <body>
          <div class="cmz-row-card">
            <div class="cmz-row-content">
              <div class="cmz-row-title">FROM S04E01 The Arrival 2160p AMZN WEB-DL [(Hindi + English) DDP 5.1] H.265 (FLUX-DTiNS).mkv</div>
            </div>
            <div class="cmz-btn-group">
              <a href="https://example.com/file?id=123" class="cmz-download-btn">6.06 GB</a>
            </div>
          </div>
        </body>
      </html>
    `;
    const result = parseSourcePage(cardHtml, 'https://example-authorized-site.test/tvshows/from/');
    expect(result.discoveredLinks.length).toBe(1);
    const link = result.discoveredLinks[0];
    expect(link.rowTitle).toBe('FROM S04E01 The Arrival 2160p AMZN WEB-DL [(Hindi + English) DDP 5.1] H.265 (FLUX-DTiNS).mkv');
    expect(link.filename).toBe('FROM S04E01 The Arrival 2160p AMZN WEB-DL [(Hindi + English) DDP 5.1] H.265 (FLUX-DTiNS).mkv');
    expect(link.quality).toBe('2160p');
    expect(link.codec).toBe('H.265');
    expect(link.season).toBe(4);
    expect(link.episode).toBe(1);
    expect(link.sizeDisplay).toBe('6.06 GB');
  });
});

describe('Phase 2: Intermediate Page Link Discovery & Token Handling', () => {
  it('discovers publicly exposed destination link from intermediate page', () => {
    const html = fs.readFileSync(path.join(fixturesDir, 'intermediate-page.html'), 'utf-8');
    const pageUrl = 'https://example-authorized-site.test/intermediate?file=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9';

    const result = discoverExposedDestination(html, pageUrl);

    expect(result.status).toBe('DISCOVERED');
    expect(result.destinationUrl).toBe('https://gdflix.example/file/9QWlfgZTmmiv837');
    expect(result.provider).toBe('GDFLIX');
    expect(result.sourceToken).toBe('eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9');
  });

  it('preserves opaque tokens without base64 decoding them', () => {
    const url = 'https://example-authorized-site.test/gateway?file=eyJmb28iOiJiYXIifQ==';
    const token = extractOpaqueToken(url);
    expect(token).toBe('eyJmb28iOiJiYXIifQ==');
  });

  it('stops cleanly with HUMAN_VERIFICATION_REQUIRED when intermediate page presents a challenge', () => {
    const captchaHtml = fs.readFileSync(path.join(fixturesDir, 'captcha-page.html'), 'utf-8');
    const pageUrl = 'https://example-authorized-site.test/challenge-step';

    const result = discoverExposedDestination(captchaHtml, pageUrl);
    expect(result.status).toBe('HUMAN_VERIFICATION_REQUIRED');
    expect(result.destinationUrl).toBeNull();
  });
});

describe('Phase 3: GDFLIX Provider Parser & File ID Extraction', () => {
  it('extracts file ID from provider URL without assuming it is the download file', () => {
    const url = 'https://provider.example/file/9QWlfgZTmmiv837';
    const fileId = extractGdflixFileId(url);
    expect(fileId).toBe('9QWlfgZTmmiv837');
  });

  it('parses publicly displayed file-information page', () => {
    const html = fs.readFileSync(path.join(fixturesDir, 'gdflix-page.html'), 'utf-8');
    const url = 'https://provider.example/file/9QWlfgZTmmiv837';

    const result = parseGdflix(html, url);

    expect(result.provider).toBe('GDFLIX');
    expect(result.fileId).toBe('9QWlfgZTmmiv837');
    expect(result.filename).toBe('Example.Show.2026.S01.2160p.HS.WEB-DL.MULTI.DDPA.5.1.Atmos.H.265.zip');
    expect(result.format).toBe('zip');
    expect(result.sizeDisplay).toBe('39.47 GB');
    expect(result.sizeBytes).toBeGreaterThan(40000000000);
    expect(result.addedDate).toBe('2026-03-15');
    expect(result.mirrors.length).toBe(2);
    expect(result.mirrors[0].url).toBe('https://mirror1.example/download/fast123');
    expect(result.mirrors[1].url).toBe('https://mirror2.example/download/cloud456');
  });
});

describe('Phase 3: Metadata Parser for Filenames', () => {
  it('extracts structured fields from release filename', () => {
    const filename = 'Example.Show.2026.S01.2160p.HS.WEB-DL.MULTI.DDPA.5.1.Atmos.H.265.zip';
    const meta = parseFilenameMetadata(filename);

    expect(meta.title).toBe('Example Show');
    expect(meta.year).toBe(2026);
    expect(meta.season).toBe(1);
    expect(meta.quality).toBe('2160p');
    expect(meta.source).toBe('WEB-DL');
    expect(meta.codec).toBe('H.265');
    expect(meta.audio).toContain('DDPA');
    expect(meta.audio).toContain('5.1');
    expect(meta.audio).toContain('Atmos');
    expect(meta.languages).toContain('MULTI');
    expect(meta.extension).toBe('zip');
  });

  it('returns null for unknown fields rather than guessing', () => {
    const filename = 'Documentary.mp4';
    const meta = parseFilenameMetadata(filename);

    expect(meta.title).toBe('Documentary');
    expect(meta.year).toBeNull();
    expect(meta.season).toBeNull();
    expect(meta.episode).toBeNull();
    expect(meta.quality).toBeNull();
    expect(meta.source).toBeNull();
    expect(meta.codec).toBeNull();
    expect(meta.extension).toBe('mp4');
  });
});

describe('Phase 3: Size Normalization & Mirror Extraction', () => {
  it('converts human-readable sizes to integer bytes and retains display format', () => {
    const gb = normalizeSize('39.47 GB');
    expect(gb.sizeDisplay).toBe('39.47 GB');
    expect(gb.sizeBytes).toBe(Math.round(39.47 * 1024 * 1024 * 1024));

    const mb = normalizeSize('750 MB');
    expect(mb.sizeBytes).toBe(750 * 1024 * 1024);

    const kb = normalizeSize('512 KB');
    expect(kb.sizeBytes).toBe(512 * 1024);

    expect(parseSizeToBytes('invalid')).toBeNull();
  });

  it('extracts mirror links array without following them automatically', () => {
    const html = fs.readFileSync(path.join(fixturesDir, 'gdflix-page.html'), 'utf-8');
    const mirrors = extractMirrors(html, 'https://provider.example/file/9QWlfgZTmmiv837');

    expect(Array.isArray(mirrors)).toBe(true);
    expect(mirrors.length).toBe(2);
    expect(mirrors[0].name).toContain('Mirror 1');
    expect(mirrors[0].type).toBe('direct');
    expect(mirrors[1].name).toContain('Mirror 2');
    expect(mirrors[1].type).toBe('cloud');
  });
});
