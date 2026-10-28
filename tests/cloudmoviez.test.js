import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractPageTitle,
  decodeFilePayload,
  detectQuality,
  detectCodec,
  detectSeasonEpisode,
  detectContentTypeFromUrl,
} from '../src/providers/cloudmoviez/parser.js';
import { extractCloudMoviezLinks } from '../src/providers/cloudmoviez/extractor.js';

describe('CloudMoviez Provider & Extractor Suite', () => {
  it('correctly decodes base64 JSON payload embedded in ?file= query parameter', () => {
    const rawUrl = 'https://c1.cloudmoviez.shop/?file=eyJ1cmwiOiJodHRwczpcL1wvZ2RmbGl4LmRldlwvZmlsZVwvYklvbVo1QzBBUHBNa0k4IiwicG9zdCI6ODkyNDUsInRpdGxlIjoiR0RGTElYIn0=';
    const payload = decodeFilePayload(rawUrl);

    expect(payload).not.toBeNull();
    expect(payload.url).toBe('https://gdflix.dev/file/bIomZ5C0APpMkI8');
    expect(payload.post).toBe(89245);
    expect(payload.title).toBe('GDFLIX');
  });

  it('correctly decodes DotFlix base64 JSON payload', () => {
    const rawUrl = 'https://c1.cloudmoviez.shop/?file=eyJ1cmwiOiJodHRwczpcL1wvZHRmbGl4Lmlua1wvc2hhcmVcLzAyM0NFQzg2IiwicG9zdCI6ODkyNDUsInRpdGxlIjoiRE9URkxJWCJ9';
    const payload = decodeFilePayload(rawUrl);

    expect(payload).not.toBeNull();
    expect(payload.url).toBe('https://dtflix.ink/share/023CEC86');
    expect(payload.post).toBe(89245);
    expect(payload.title).toBe('DOTFLIX');
  });

  it('accurately identifies quality and codecs without false positives', () => {
    expect(detectQuality('Dridam (2026) 2160p AMZN WEb-DL')).toBe('2160p');
    expect(detectQuality('Dridam (2026) 1080p 10bit DS4K AMZN')).toBe('1080p');
    expect(detectQuality('Dridam (2026) 720p HS WEB-DL')).toBe('720p');

    expect(detectCodec('H.265 CloudMovieZ.Top.mkv')).toBe('H.265');
    expect(detectCodec('AVC.H.264-CloudMovieZ.Top.mkv')).toBe('H.264');
  });

  it('handles DS4K without falsely detecting Season 4', () => {
    const se = detectSeasonEpisode('1080p 10bit DS4K AMZN WEb-DL');
    expect(se.season).toBeNull();
    expect(se.episode).toBeNull();
  });

  it('accurately detects Season and Episode for TV series titles', () => {
    const ep1 = detectSeasonEpisode('Season 1 S01E03 Episode 3 1080p');
    expect(ep1.season).toBe(1);
    expect(ep1.episode).toBe(3);

    const seOnly = detectSeasonEpisode('Season 2 Complete Batch Zip');
    expect(seOnly.season).toBe(2);
    expect(seOnly.episode).toBeNull();
  });

  it('extracts all 9 movie releases from Dridam fixture HTML', () => {
    const fixturePath = 'C:\\Users\\sk621\\.gemini\\antigravity\\brain\\b33580c9-6704-4b15-8fdf-79aa883aec93\\scratch\\cmz_dridam.html';
    if (!fs.existsSync(fixturePath)) {
      return; // Skip if scratch fixture is not on disk
    }

    const html = fs.readFileSync(fixturePath, 'utf8');
    const result = extractCloudMoviezLinks(html, 'https://c1.cloudmoviez.shop/movies/dridam/');

    expect(result.title).toBe('Dridam');
    expect(result.contentType).toBe('movie');
    expect(result.links.length).toBe(9);

    // Verify all releases are classified as movie
    expect(result.links.every((l) => l.scope === 'movie')).toBe(true);

    // Verify direct decoded provider URLs
    expect(result.links[0].providerUrl).toBe('https://gdflix.dev/file/bIomZ5C0APpMkI8');
    expect(result.links[0].quality).toBe('2160p');
    expect(result.links[0].sizeDisplay).toBe('19.47 GB');
    expect(result.links[0].provider).toBe('GDFLIX');
    expect(result.links[0].status).toBe('RESOLVED');

    // Verify 1080p release
    const p1080 = result.links.filter((l) => l.quality === '1080p');
    expect(p1080.length).toBe(5);

    // Verify 720p release
    const p720 = result.links.filter((l) => l.quality === '720p');
    expect(p720.length).toBe(2);
  });

  it('filters extracted links by target quality when specified', () => {
    const fixturePath = 'C:\\Users\\sk621\\.gemini\\antigravity\\brain\\b33580c9-6704-4b15-8fdf-79aa883aec93\\scratch\\cmz_dridam.html';
    if (!fs.existsSync(fixturePath)) return;

    const html = fs.readFileSync(fixturePath, 'utf8');
    const result2160 = extractCloudMoviezLinks(html, 'https://c1.cloudmoviez.shop/movies/dridam/', {
      targetQuality: '2160p',
    });

    expect(result2160.links.length).toBe(2);
    expect(result2160.links.every((l) => l.quality === '2160p')).toBe(true);
    expect(result2160.allLinks.length).toBe(9);
  });

  it('correctly handles TV Series structure with episodes and packs', () => {
    const tvHtml = `
      <!DOCTYPE html><html><body>
        <h1>Muthu alias Kaattaan</h1>
        <div class="cmz-accordion">
          <div class="cmz-accordion-title">Season 1 Complete Zip [1080p]</div>
          <div class="cmz-accordion-tags">Tamil, Hindi</div>
          <div class="cmz-row-card">
            <div class="cmz-row-title">Muthu.S01.Complete.1080p.mkv</div>
            <div class="cmz-btn-group">
              <a class="cmz-download-btn cmz-btn-gdflix" href="https://c1.cloudmoviez.shop/?file=eyJ1cmwiOiJodHRwczpcL1wvZ2RmbGl4LmRldlwvZmlsZVwvTVVUSFVTMDFFMDFQSyIsInBvc3QiOjEyMzR9"><span>G</span>4.2 GB</a>
            </div>
          </div>
        </div>
        <div class="cmz-accordion">
          <div class="cmz-accordion-title">Season 1 Single Episodes [720p]</div>
          <div class="cmz-row-card">
            <div class="cmz-row-title">Muthu S01E01 Episode 1 720p.mkv</div>
            <div class="cmz-btn-group">
              <a class="cmz-download-btn cmz-btn-gdflix" href="https://c1.cloudmoviez.shop/?file=eyJ1cmwiOiJodHRwczpcL1wvZ2RmbGl4LmRldlwvZmlsZVwvTVVUSFVTMDFFMDEiLCJwb3N0IjoxMjM1fQ=="><span>G</span>450 MB</a>
            </div>
          </div>
        </div>
      </body></html>
    `;

    const result = extractCloudMoviezLinks(tvHtml, 'https://c1.cloudmoviez.shop/tvshows/muthu-alias-kaattaan/');
    expect(result.contentType).toBe('series');
    expect(result.links.length).toBe(2);

    const pack = result.links.find((l) => l.scope === 'pack');
    expect(pack).toBeDefined();
    expect(pack.season).toBe(1);
    expect(pack.providerUrl).toBe('https://gdflix.dev/file/MUTHUS01E01PK');

    const ep = result.links.find((l) => l.scope === 'episode');
    expect(ep).toBeDefined();
    expect(ep.season).toBe(1);
    expect(ep.episode).toBe(1);
    expect(ep.providerUrl).toBe('https://gdflix.dev/file/MUTHUS01E01');
  });

  it('extracts all 16 releases from classic CloudMoviez WordPress download blocks (Maamla Legal Hai)', () => {
    const fixturePath = 'scratch/maamla.html';
    if (!fs.existsSync(fixturePath)) return;

    const html = fs.readFileSync(fixturePath, 'utf8');
    const result = extractCloudMoviezLinks(html, 'https://c1.cloudmoviez.shop/tvshows/maamla-legal-hai/');

    expect(result.title).toBe('Maamla Legal Hai [Season 1]');
    expect(result.cleanTitle).toBe('Maamla Legal Hai');
    expect(result.contentType).toBe('series');
    expect(result.links.length).toBe(16);

    const zipPacks = result.links.filter((l) => l.scope === 'pack');
    expect(zipPacks.length).toBe(8);

    const epPacks = result.links.filter((l) => l.scope === 'episode');
    expect(epPacks.length).toBe(8);

    expect(zipPacks[0].quality).toBe('720p');
    expect(zipPacks[0].sizeDisplay).toBe('2.6GB');
    expect(zipPacks[0].providerUrl).toBe('https://c1.cloudmoviez.shop/links/0lo9awtcve/');
  });
});
