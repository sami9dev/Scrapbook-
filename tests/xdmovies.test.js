import { describe, it, expect } from 'vitest';
import { isXDMoviesUrl, isXDMoviesMediatorUrl } from '../src/scrapers/xdmovies/types.js';
import { parseXDMoviesCatalogue } from '../src/scrapers/xdmovies/catalogue.js';
import { canonicalHubCloudUrl } from '../src/scrapers/xdmovies/mediator.js';
import { resolveXDMovies } from '../src/scrapers/xdmovies/resolver.js';

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
