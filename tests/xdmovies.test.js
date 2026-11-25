import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import { isXDMoviesUrl, isXDMoviesMediatorUrl } from '../src/scrapers/xdmovies/types.js';
import { parseXDMoviesCatalogue } from '../src/scrapers/xdmovies/catalogue.js';
import { canonicalHubCloudUrl } from '../src/scrapers/xdmovies/mediator.js';
import { resolveXDMovies } from '../src/scrapers/xdmovies/resolver.js';
import { dbManager } from '../src/database/mongodb.js';
import { scrapedLinksRepo, jobsRepo } from '../src/database/models.js';
import * as catalogStore from '../src/utils/catalog-store.js';
import { createApp } from '../src/index.js';

const SAMPLE_MOVIE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Gajab Raat (2025) Hindi + Tamil 2160p 1080p 720p - XDMovies</title>
</head>
<body>
  <div class="movie-header">
    <h1 class="movie-title">Gajab Raat (2025)</h1>
  </div>
  <div class="download-container">
    <div class="download-item">
      <div class="download-title">Gajab.Raat.2025.2160p.HQ.SDR.WEB-DL.Hindi.Tamil.DDP5.1.Atmos.x264</div>
      <span class="file-size">4.2 GB</span>
      <span class="quality-badge">2160p</span>
      <a href="https://link.xdmovies.wtf/download/sample-2160p-id" class="download-btn">HubCloud Direct</a>
    </div>
    <div class="download-item">
      <div class="download-title">Gajab.Raat.2025.1080p.HQ.10Bit.WEB-DL.Hindi.Tamil.DDP5.1.Atmos.HEVC</div>
      <span class="file-size">1.8 GB</span>
      <span class="quality-badge">1080p</span>
      <a href="https://link.xdmovies.wtf/download/sample-1080p-id" class="download-btn">HubCloud Direct</a>
    </div>
    <div class="download-item">
      <div class="download-title">Gajab.Raat.2025.720p.WEB-DL.Hindi.Tamil.AAC2.0.x264</div>
      <span class="file-size">850 MB</span>
      <span class="quality-badge">720p</span>
      <a href="https://link.xdmovies.wtf/download/sample-720p-id" class="download-btn">HubCloud Direct</a>
    </div>
  </div>
</body>
</html>
`;

const SAMPLE_SERIES_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Fading Grandeur (Season 1) Hindi + Spanish 1080p 720p - XDMovies</title>
</head>
<body>
  <div class="series-header">
    <h1 class="series-title">Fading Grandeur (Season 1)</h1>
  </div>
  <div class="packs-section">
    <div class="pack-card">
      <div class="pack-title">Fading Grandeur (Season 1) 1080p Complete Zip Pack [Hindi - Spanish] WEB-DL</div>
      <span class="file-size">8.5 GB</span>
      <a href="https://link.xdmovies.wtf/download/sample-pack-1080p" class="download-btn">Download Pack</a>
    </div>
  </div>
  <div class="episodes-section" id="season-1">
    <div class="episode-card">
      <div class="episode-title">Fading Grandeur S01E01 1080p Hindi-Spanish</div>
      <span class="codec-badge">HEVC</span>
      <a href="https://link.xdmovies.wtf/download/sample-s01e01" class="download-btn">Episode 1</a>
    </div>
    <div class="episode-card">
      <div class="episode-title">Fading Grandeur S01E02 1080p Hindi-Spanish</div>
      <span class="codec-badge">HEVC</span>
      <a href="https://link.xdmovies.wtf/download/sample-s01e02" class="download-btn">Episode 2</a>
    </div>
  </div>
</body>
</html>
`;

describe('XDMovies URL Validators', () => {
  it('identifies primary and mirror XDMovies source URLs', () => {
    expect(isXDMoviesUrl('https://huh.xdmovies.wtf/movies/gajab-raat-2160p-1080p-hindi-tamil-download-1453407')).toBe(true);
    expect(isXDMoviesUrl('https://top.xdmovies.wtf/series/fading-grandeur-1080p-720p-hindi-spanish-download-335535')).toBe(true);
    expect(isXDMoviesUrl('https://xdmovies.wtf/')).toBe(true);
    expect(isXDMoviesUrl('https://4khdhub.one/some-movie')).toBe(false);
    expect(isXDMoviesUrl('https://google.com')).toBe(false);
  });

  it('identifies XDMovies mediator URLs', () => {
    expect(isXDMoviesMediatorUrl('https://link.xdmovies.wtf/download/12345')).toBe(true);
    expect(isXDMoviesMediatorUrl('https://latestnewsonline.sbs/r/abcxyz?step=2&sid=foo')).toBe(true);
    expect(isXDMoviesMediatorUrl('https://huh.xdmovies.wtf/movies/some-slug')).toBe(false);
  });

  it('normalizes HubCloud URLs to canonical hubcloud.ist', () => {
    expect(canonicalHubCloudUrl('https://hubcloud.club/drive/x9yxpeyxwcyeaxy')).toBe('https://hubcloud.ist/drive/x9yxpeyxwcyeaxy');
    expect(canonicalHubCloudUrl('https://hubcloud.one/drive/rinh3ukgyn8wwbg?download=1')).toBe('https://hubcloud.ist/drive/rinh3ukgyn8wwbg?download=1');
    expect(canonicalHubCloudUrl('https://hubcloud.ist/drive/x9yxpeyxwcyeaxy')).toBe('https://hubcloud.ist/drive/x9yxpeyxwcyeaxy');
  });
});

describe('XDMovies Catalogue Parser', () => {
  it('parses a multi-quality movie page into structured releases and download links', () => {
    const catalogue = parseXDMoviesCatalogue(SAMPLE_MOVIE_HTML, 'https://huh.xdmovies.wtf/movies/gajab-raat-2160p-1080p-hindi-tamil-download-1453407');
    expect(catalogue.source).toBe('xdmovies');
    expect(catalogue.title).toContain('Gajab Raat');
    expect(catalogue.type).toBe('movie');
    expect(catalogue.totalReleases).toBe(3);
    expect(catalogue.totalLinks).toBe(3);

    const q2160 = catalogue.qualities.find((q) => q.resolution === '2160p');
    expect(q2160).toBeDefined();
    expect(q2160.releases.length).toBe(1);
    expect(q2160.releases[0].fileSize).toBe('4.2 GB');
    expect(q2160.releases[0].downloadLinks[0].url).toContain('sample-2160p-id');

    const q1080 = catalogue.qualities.find((q) => q.resolution === '1080p');
    expect(q1080).toBeDefined();
    expect(q1080.releases[0].codec).toBe('HEVC');
    expect(q1080.releases[0].fileSize).toBe('1.8 GB');

    const q720 = catalogue.qualities.find((q) => q.resolution === '720p');
    expect(q720).toBeDefined();
    expect(q720.releases[0].fileSize).toBe('850 MB');
  });

  it('parses live Netflix multi-edition movie page with 8 releases across 2160p, 1080p, and 720p', () => {
    const liveHtml = `
      <div class="info">
        <h2>Gajab Raat</h2>
        <div class="download-box">
          <div class="download-item">
            <div class="custom-title">Gajab.Raat.2026.720p.NF.WEB-DL.AAC5.1.AV1-XDMovies.com.mkv</div>
            <a href="https://link.xdmovies.wtf/download/H26FW1pt5xyhCLEvP9eG__ATQVHxF3QjHOdMs8qEvSY" class="movie-download-btn">0.84 GB</a>
          </div>
          <div class="download-item">
            <div class="custom-title">Gajab.Raat.2026.720p.NF.WEB-DL.AAC5.1.H.264-XDMovies.com.mkv</div>
            <a href="https://link.xdmovies.wtf/download/OvDE8su5SyBO5Es9iKZBuwaENFgH6-JXAmgEGI3Hznk" class="movie-download-btn">1.99 GB</a>
          </div>
          <div class="download-item">
            <div class="custom-title">Gajab.Raat.2026.1080p.NF.WEB-DL.DDP5.1.Atmos.AV1-XDMovies.com.mkv</div>
            <a href="https://link.xdmovies.wtf/download/srYPaKRLUuYkBH01wCp2YdIv6CTj_dhimj0vjBRkT5Q" class="movie-download-btn">2.28 GB</a>
          </div>
          <div class="download-item">
            <div class="custom-title">Gajab.Raat.2026.1080p.NF.WEB-DL.DDP5.1.Atmos.H.265-XDMovies.com.mkv</div>
            <a href="https://link.xdmovies.wtf/download/0RPgQCmfj6TBNkyCHkuVGB35H-nIv8IN0QG0FGL8ub4" class="movie-download-btn">3.63 GB</a>
          </div>
          <div class="download-item">
            <div class="custom-title">Gajab.Raat.2026.1080p.NF.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-XDMovies.com.mkv</div>
            <a href="https://link.xdmovies.wtf/download/w4-jjmqo-k-tNf5Tjc6FsOF7g81TEm479of0Jyaoh44" class="movie-download-btn">4.18 GB</a>
          </div>
          <div class="download-item">
            <div class="custom-title">Gajab.Raat.2026.1080p.NF.WEB-DL.DDP5.1.Atmos.H.264-XDMovies.com.mkv</div>
            <a href="https://link.xdmovies.wtf/download/ptAJZwtUrMgCiVdNayT3FwO5BxfWn-TSZZp10bvGdiE" class="movie-download-btn">6.07 GB</a>
          </div>
          <div class="download-item">
            <div class="custom-title">Gajab.Raat.2026.2160p.NF.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-XDMovies.com.mkv</div>
            <a href="https://link.xdmovies.wtf/download/4Pb0h8OLaypaIrap5fnMQ647EkEK4-qkAlV7afZMWhY" class="movie-download-btn">12.31 GB</a>
          </div>
          <div class="download-item">
            <div class="custom-title">Gajab.Raat.2026.2160p.NF.WEB-DL.DDP5.1.Atmos.H.265-XDMovies.com.mkv</div>
            <a href="https://link.xdmovies.wtf/download/3z4M0ZnIh8uPrfj37c2ZKqgZKjdi5PGK5oLA6ImyUg4" class="movie-download-btn">15.56 GB</a>
          </div>
        </div>
      </div>
    `;

    const cat = parseXDMoviesCatalogue(liveHtml, 'https://huh.xdmovies.wtf/movies/gajab-raat-2160p-1080p-hindi-tamil-download-1453407');
    expect(cat.totalReleases).toBe(8);
    expect(cat.totalLinks).toBe(8);
    expect(cat.qualities.find(q => q.resolution === '2160p').releases.length).toBe(2);
    expect(cat.qualities.find(q => q.resolution === '1080p').releases.length).toBe(4);
    expect(cat.qualities.find(q => q.resolution === '720p').releases.length).toBe(2);
  });

  it('parses TV series page with complete season packs and individual episodes', () => {
    const catalogue = parseXDMoviesCatalogue(SAMPLE_SERIES_HTML, 'https://huh.xdmovies.wtf/series/fading-grandeur-1080p-720p-hindi-spanish-download-335535');
    expect(catalogue.source).toBe('xdmovies');
    expect(catalogue.title).toContain('Fading Grandeur');
    expect(catalogue.type).toBe('series');
    expect(catalogue.totalReleases).toBe(3); // 1 pack + 2 episodes

    const packRelease = catalogue.seasons[0].releases.find((r) => r.scope === 'pack');
    expect(packRelease).toBeDefined();
    expect(packRelease.season).toBe(1);
    expect(packRelease.fileSize).toBe('8.5 GB');
    expect(packRelease.downloadLinks[0].url).toContain('sample-pack-1080p');

    const ep1 = catalogue.seasons[0].releases.find((r) => r.scope === 'episode' && r.episode === 1);
    expect(ep1).toBeDefined();
    expect(ep1.season).toBe(1);
    expect(ep1.episode).toBe(1);
    expect(ep1.downloadLinks[0].url).toContain('sample-s01e01');
  });

  it('parses multi-season series with 3 seasons and 13 complete zip packs accurately', () => {
    const counts = [5, 4, 4];
    const sections = counts.map((n, idx) => {
      const s = idx + 1;
      const cards = Array.from({ length: n }, (_, i) => {
        const q = i === 0 ? '2160p' : (i === 1 ? '1080p.H.265' : (i === 2 ? '1080p.H.264' : (i === 3 ? '720p' : '480p')));
        return `<div class="pack-card"><div class="pack-info"><h4 class="pack-title">Delhi.Crime.S0${s}.${q}.NF.WEB-DL-XDMovies.com.zip</h4><a href="https://link.xdmovies.wtf/download/dc_s${s}_${i}" class="download-button"><span class="size-badge">${(i + 1) * 2}.5 GB</span></a></div></div>`;
      }).join('');
      return `<div class="season-section"><button class="toggle-season-btn">Season ${s} Packs/Zips</button><div id="season-packs-${s}" class="season-episodes"><div class="packs-grid">${cards}</div></div></div>`;
    }).join('');
    const html = `<html><head><title>Delhi Crime - XDMovies</title></head><body><h2>Delhi Crime</h2><div class="seasons-container">${sections}</div></body></html>`;

    const catalogue = parseXDMoviesCatalogue(html, 'https://huh.xdmovies.wtf/series/delhi-crime-2160p-1080p-hindi-english-download-87508');
    expect(catalogue.type).toBe('series');
    expect(catalogue.seasons.length).toBe(3);
    expect(catalogue.totalReleases).toBe(13);
    expect(catalogue.seasons[0].releases.length).toBe(5);
    expect(catalogue.seasons[1].releases.length).toBe(4);
    expect(catalogue.seasons[2].releases.length).toBe(4);
    expect(catalogue.seasons.every((s) => s.releases.every((r) => r.scope === 'pack'))).toBe(true);
  });

  it('auto-detects canonical sourceUrl regardless of attribute order and indexes all 13 packs via /api/parse-html', async () => {
    await dbManager.connect('mongodb://localhost:27017/test_db', { forceInMemory: true });
    const origLinksFile = scrapedLinksRepo.collection.storageFile;
    const origJobsFile = jobsRepo.collection.storageFile;
    const origLinksDocs = [...scrapedLinksRepo.collection.documents];
    const origJobsDocs = [...jobsRepo.collection.documents];
    const tmpDir = os.tmpdir();
    scrapedLinksRepo.collection.storageFile = path.join(tmpDir, 'test_parse_html_links.json');
    jobsRepo.collection.storageFile = path.join(tmpDir, 'test_parse_html_jobs.json');
    scrapedLinksRepo.collection.documents = [];
    jobsRepo.collection.documents = [];
    await scrapedLinksRepo.initIndexes();
    await jobsRepo.initIndexes();

    const catalogSpy = vi.spyOn(catalogStore, 'recordInCatalog').mockImplementation(() => false);
    const app = await createApp();
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}/api`;
      const counts = [5, 4, 4];
      const sections = counts.map((n, idx) => {
        const s = idx + 1;
        const cards = Array.from({ length: n }, (_, i) => {
          const q = i === 0 ? '2160p' : (i === 1 ? '1080p.H.265' : (i === 2 ? '1080p.H.264' : (i === 3 ? '720p' : '480p')));
          return `<div class="pack-card"><div class="pack-info"><h4 class="pack-title">Delhi.Crime.S0${s}.${q}.NF.WEB-DL-XDMovies.com.zip</h4><a href="https://link.xdmovies.wtf/download/dc_s${s}_${i}" class="download-button"><span class="size-badge">${(i + 1) * 2}.5 GB</span></a></div></div>`;
        }).join('');
        return `<div class="season-section"><button class="toggle-season-btn">Season ${s} Packs/Zips</button><div id="season-packs-${s}" class="season-episodes"><div class="packs-grid">${cards}</div></div></div>`;
      }).join('');

      // Relative canonical URL with href BEFORE rel
      const html = `<html><head><link href="/series/delhi-crime-2160p-1080p-hindi-english-download-87508" rel="canonical"><title>Delhi Crime - XDMovies</title></head><body><h2>Delhi Crime</h2><div class="seasons-container">${sections}</div></body></html>`;

      const parseRes = await fetch(`${base}/parse-html`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, sourceUrl: '', autoReset: true }),
      }).then((r) => r.json());

      expect(parseRes.success).toBe(true);
      expect(parseRes.count).toBe(13);

      const byUrl = await fetch(`${base}/links?sourceUrl=${encodeURIComponent('https://huh.xdmovies.wtf/series/delhi-crime-2160p-1080p-hindi-english-download-87508')}&limit=50`).then((r) => r.json());
      expect(byUrl.length).toBe(13);

      const byTitle = await fetch(`${base}/links?titleSearch=${encodeURIComponent('delhi crime')}&limit=50`).then((r) => r.json());
      expect(byTitle.length).toBe(13);
      expect(byTitle.every((r) => r.scope === 'pack')).toBe(true);
    } finally {
      server.close();
      catalogSpy.mockRestore();
      scrapedLinksRepo.collection.storageFile = origLinksFile;
      jobsRepo.collection.storageFile = origJobsFile;
      scrapedLinksRepo.collection.documents = origLinksDocs;
      jobsRepo.collection.documents = origJobsDocs;
    }
  });

  it('shows Season filter pills and separates seasons when Season Packs (Zip) tab is selected in dashboard HTML', () => {
    const html = fs.readFileSync(path.resolve('src/public/index.html'), 'utf8');
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
    expect(scriptMatch).not.toBeNull();

    const makeEl = (id, attrs = {}) => ({
      id,
      attrs: { ...attrs },
      style: {},
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
      children: [],
      innerHTML: '',
      textContent: '',
      value: '',
      checked: true,
      addEventListener() {},
      querySelectorAll() { return []; },
      getAttribute(k) { return this.attrs[k] ?? null; },
    });

    const elements = {
      linksTableBody: makeEl('linksTableBody'),
      seasonFilterGroup: makeEl('seasonFilterGroup'),
      seasonFilterPills: makeEl('seasonFilterPills'),
      filteredCountInfo: makeEl('filteredCountInfo'),
      tabCountEpisodes: makeEl('tabCountEpisodes'),
      tabCountPacks: makeEl('tabCountPacks'),
      tabCountAll: makeEl('tabCountAll'),
      tabCountMovies: makeEl('tabCountMovies'),
      viewTableLinkCount: makeEl('viewTableLinkCount'),
      recordModal: makeEl('recordModal'),
      modalJson: makeEl('modalJson'),
      modalClose: makeEl('modalClose'),
      scrapeForm: makeEl('scrapeForm'),
      targetUrl: makeEl('targetUrl'),
      targetScope: makeEl('targetScope'),
      targetQuality: makeEl('targetQuality'),
      submitBtn: makeEl('submitBtn'),
      submitFeedback: makeEl('submitFeedback'),
      refreshBtn: makeEl('refreshBtn'),
      autoResetCheckbox: makeEl('autoResetCheckbox'),
      resetDataBtn: makeEl('resetDataBtn'),
      copyFormattedBtn: makeEl('copyFormattedBtn'),
      downloadFormattedBtn: makeEl('downloadFormattedBtn'),
    };

    const sandbox = {
      console,
      fetch: async () => ({ ok: false, json: async () => [] }),
      setInterval: () => 0,
      setTimeout,
      clearTimeout,
      URL,
      navigator: {},
      window: { addEventListener() {}, scrollTo() {}, isSecureContext: false },
      document: {
        getElementById: (id) => elements[id] || null,
        querySelectorAll: () => [],
        createElement: () => makeEl('tmp'),
        body: { appendChild() {}, removeChild() {} },
      },
    };

    vm.runInNewContext(scriptMatch[1], sandbox);

    const packsAndEpisodes = [
      { _id: 'e1', scope: 'episode', season: 1, episode: 1, quality: '1080p', codec: 'HEVC', filename: 'Show.S01E01.1080p.H.265.mkv', providerUrl: 'https://hubcloud.pw/drive/ep1', status: 'RESOLVED' },
      { _id: 'p3a', scope: 'pack', season: 3, episode: null, quality: '1080p', codec: 'HEVC', filename: 'Show.S03.1080p.H.265.zip', providerUrl: 'https://hubcloud.pw/drive/s3a', status: 'RESOLVED' },
      { _id: 'p1a', scope: 'pack', season: 1, episode: null, quality: '1080p', codec: 'HEVC', filename: 'Show.S01.1080p.H.265.zip', providerUrl: 'https://hubcloud.pw/drive/s1a', status: 'RESOLVED' },
      { _id: 'p1b', scope: 'pack', season: 1, episode: null, quality: '1080p', codec: 'x264', filename: 'Show.S01.1080p.H.264.zip', providerUrl: 'https://hubcloud.pw/drive/s1b', status: 'RESOLVED' },
      { _id: 'p2a', scope: 'pack', season: 2, episode: null, quality: '720p', codec: 'x264', filename: 'Show.S02.720p.H.264.zip', providerUrl: 'https://hubcloud.pw/drive/s2a', status: 'RESOLVED' },
      { _id: 'p3b', scope: 'pack', season: 3, episode: null, quality: '720p', codec: 'AV1', filename: 'Show.S03.720p.AV1.zip', providerUrl: 'https://hubcloud.pw/drive/s3b', status: 'RESOLVED' },
    ];

    vm.runInNewContext(`allLinks = ${JSON.stringify(packsAndEpisodes)}; updateTabCounts(); setActiveScopeTab('pack', true);`, sandbox);

    expect(elements.seasonFilterGroup.style.display).toBe('flex');
    const pillOrder = [...elements.seasonFilterPills.innerHTML.matchAll(/data-season="([^"]+)"/g)].map((m) => m[1]);
    expect(pillOrder).toEqual(['all', '1', '2', '3']);
    expect(elements.linksTableBody.innerHTML).toContain('Season 1 — Complete Zip Packs (2)');
    expect(elements.linksTableBody.innerHTML).toContain('Season 2 — Complete Zip Packs (1)');
    expect(elements.linksTableBody.innerHTML).toContain('Season 3 — Complete Zip Packs (2)');

    vm.runInNewContext(`currentSeasonFilter = '3'; renderTable();`, sandbox);
    expect(elements.filteredCountInfo.textContent).toBe('Showing 2 Complete Season Packs');
    expect(elements.linksTableBody.innerHTML).toContain('Show.S03.1080p.H.265.zip');
    expect(elements.linksTableBody.innerHTML).not.toContain('Show.S01.1080p.H.265.zip');

    vm.runInNewContext(`currentSeasonFilter = 'all'; setActiveCodecPill('h265');`, sandbox);
    expect(elements.filteredCountInfo.textContent).toBe('Showing 2 Complete Season Packs');
    expect(elements.linksTableBody.innerHTML).toContain('Show.S01.1080p.H.265.zip');
    expect(elements.linksTableBody.innerHTML).toContain('Show.S03.1080p.H.265.zip');
    expect(elements.linksTableBody.innerHTML).not.toContain('H.264');

    vm.runInNewContext(`setActiveCodecPill('h264');`, sandbox);
    expect(elements.filteredCountInfo.textContent).toBe('Showing 2 Complete Season Packs');
    expect(elements.linksTableBody.innerHTML).toContain('Show.S01.1080p.H.264.zip');
    expect(elements.linksTableBody.innerHTML).toContain('Show.S02.720p.H.264.zip');
    expect(elements.linksTableBody.innerHTML).not.toContain('H.265');
  });
});

describe('XDMovies Direct Resolver Cases', () => {
  it('immediately returns canonical HubCloud destination when direct HubCloud URL is supplied', async () => {
    const res = await resolveXDMovies('https://hubcloud.club/drive/x9yxpeyxwcyeaxy', { resolveDestination: true });
    expect(res.success).toBe(true);
    expect(res.state).toBe('DESTINATION_FOUND');
    expect(res.destination).toBe('https://hubcloud.ist/drive/x9yxpeyxwcyeaxy');
    expect(res.provider).toBe('HubCloud');
  });
});
