import { describe, it, expect } from 'vitest';
import { parseXDMoviesPage } from '../src/providers/xdmovies/parser.js';
import { extractXDMoviesLinks } from '../src/providers/xdmovies/extractor.js';
import { getXDMoviesMediatorUrl, resolveXDMoviesMediator } from '../src/resolvers/xdmovies/mediator.js';

const SAMPLE_XDMOVIES_HTML = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Hunkkaar: The Roar — Series</title>
</head>
<body class="dark-mode">
  <main>
    <div class="container" id="movie-details">
      <div class="details-wrapper">
        <div class="info">
          <h2>Hunkkaar: The Roar</h2>
          <p id="audio-info"><strong>Audios:</strong> <span class="neon-audio">Hindi, Tamil, Kannada, Telugu, Malayalam, Bengali, Marathi</span></p>
          <p id="source-info"><strong>Sources:</strong> <span class="neon-source">JioHotstar</span></p>
          
          <div class="download mt-6" id="download-links">
            <h3 class="download-heading">Download Links:</h3>
            <div class="seasons-container">
              <div class="season-section">
                <button class="toggle-season-btn">Season 1 Packs/Zips</button>
                <div id="season-packs-1" class="season-episodes">
                  <div class="packs-grid">
                    <div class="pack-card">
                      <div class="pack-info">
                        <h4 class="pack-title">Hunkkaar.The.Roar.S01.2160p.JHS.WEB-DL.MULTi.DDP5.1.Atmos.H.265-PMi-XDMovies.zip</h4>
                        <a href="https://link.xdmovies.wtf/download/35JYqe90esCLUA70deSc3SZSxO-Dzi1_wPmMVotFbQg" target="_blank" class="download-button">
                          <span class="size-badge">39.44 GB</span>
                        </a>
                      </div>
                    </div>
                    <div class="pack-card">
                      <div class="pack-info">
                        <h4 class="pack-title">Hunkkaar.The.Roar.S01.1080p.JHS.WEB-DL.MULTi.DDP5.1.Atmos.H.265-PMi-XDMovies.zip</h4>
                        <a href="https://link.xdmovies.wtf/download/LCj8T3wK656yj753RiV-MLLfr1JpFyw6qSTnB7L-pxM" target="_blank" class="download-button">
                          <span class="size-badge">10.02 GB</span>
                        </a>
                      </div>
                    </div>
                  </div>
                </div>

                <button class="toggle-season-btn">Season 1 Episodes</button>
                <div id="season-episodes-1" class="season-episodes">
                  <div class="quality-section">
                    <button class="toggle-quality-btn">2160p</button>
                    <div id="quality-1-2160p" class="quality-episodes">
                      <div class="codec-section mb-3" data-codec="SDR">
                        <div class="episodes-grid">
                          <div class="episode-card">
                            <div class="episode-info">
                              <div class="episode-title">Hunkkaar.The.Roar.S01E01.Aarambh.2160p.JHS.WEB-DL.MULTi.DDP5.1.Atmos.H.265-PMi-XDMovies.mkv</div>
                              <div class="codec-badge">SDR</div>
                            </div>
                            <a href="https://link.xdmovies.wtf/download/VP9A6w2JCRKNGTJ4nbCNek1HCyBQgDPNgDYJtkAuMec" target="_blank" class="movie-download-btn">
                              6.53 GB
                            </a>
                          </div>
                          <div class="episode-card">
                            <div class="episode-info">
                              <div class="episode-title">Hunkkaar.The.Roar.S01E02.Aastha.2160p.JHS.WEB-DL.MULTi.DDP5.1.Atmos.H.265-PMi-XDMovies.mkv</div>
                              <div class="codec-badge">SDR</div>
                            </div>
                            <a href="https://link.xdmovies.wtf/download/qNTF_sh0kav_4Mjp9lgu1HGriUrUSTq7eLXuwRyNP1g" target="_blank" class="movie-download-btn">
                              6.50 GB
                            </a>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
</body>
</html>
`;

describe('XDMovies Provider & Extractor Test Suite', () => {
  it('parses TV series page and accurately distinguishes packs vs episodes', () => {
    const result = parseXDMoviesPage(SAMPLE_XDMOVIES_HTML, 'https://top.xdmovies.wtf/series/hunkkaar-the-roar/');

    expect(result.title).toBe('Hunkkaar: The Roar');
    expect(result.type).toBe('tv');
    expect(result.audios).toContain('Hindi');
    expect(result.audios).toContain('Tamil');
    expect(result.ottSource).toBe('JioHotstar');

    const packs = result.links.filter((l) => l.scope === 'pack');
    const episodes = result.links.filter((l) => l.scope === 'episode');

    expect(packs.length).toBe(2);
    expect(episodes.length).toBe(2);

    // Verify Pack
    expect(packs[0].filename).toBe('Hunkkaar.The.Roar.S01.2160p.JHS.WEB-DL.MULTi.DDP5.1.Atmos.H.265-PMi-XDMovies.zip');
    expect(packs[0].quality).toBe('2160p');
    expect(packs[0].season).toBe(1);
    expect(packs[0].sizeDisplay).toBe('39.44 GB');
    expect(packs[0].redirectUrl).toContain('/download/35JYqe90esCLUA70deSc3SZSxO-Dzi1_wPmMVotFbQg');

    // Verify Episode
    expect(episodes[0].filename).toBe('Hunkkaar.The.Roar.S01E01.Aarambh.2160p.JHS.WEB-DL.MULTi.DDP5.1.Atmos.H.265-PMi-XDMovies.mkv');
    expect(episodes[0].quality).toBe('2160p');
    expect(episodes[0].season).toBe(1);
    expect(episodes[0].episode).toBe(1);
    expect(episodes[0].codec).toBe('SDR');
    expect(episodes[0].sizeDisplay).toBe('6.53 GB');
    expect(episodes[0].redirectUrl).toContain('/download/VP9A6w2JCRKNGTJ4nbCNek1HCyBQgDPNgDYJtkAuMec');
  });

  it('filters extracted links by targetScope', () => {
    const episodesOnly = extractXDMoviesLinks(SAMPLE_XDMOVIES_HTML, 'https://top.xdmovies.wtf/series/hunkkaar/', {
      targetScope: 'episode',
    });
    expect(episodesOnly.links.every((l) => l.scope === 'episode')).toBe(true);
    expect(episodesOnly.links.length).toBe(2);

    const packsOnly = extractXDMoviesLinks(SAMPLE_XDMOVIES_HTML, 'https://top.xdmovies.wtf/series/hunkkaar/', {
      targetScope: 'pack',
    });
    expect(packsOnly.links.every((l) => l.scope === 'pack')).toBe(true);
    expect(packsOnly.links.length).toBe(2);
  });

  it('filters extracted links by targetQuality', () => {
    const q1080 = extractXDMoviesLinks(SAMPLE_XDMOVIES_HTML, 'https://top.xdmovies.wtf/series/hunkkaar/', {
      targetQuality: '1080p',
    });
    expect(q1080.links.length).toBe(1);
    expect(q1080.links[0].quality).toBe('1080p');
  });

  it('handles mediator resolution when link is already a HubCloud destination', async () => {
    const testHubUrl = 'https://hubcloud.ist/drive/1yvalri1a1jiizq';
    const result = await resolveXDMoviesMediator(testHubUrl, {
      meta: { title: 'Hunkkaar.The.Roar.S01.2160p' },
    });

    expect(result.success).toBe(true);
    expect(result.destination).toBe(testHubUrl);
    expect(result.driveId).toBe('1yvalri1a1jiizq');
    expect(result.state).toBe('HUBCLOUD_DETECTED');
  });

  it('preserves allLinks in extractXDMoviesLinks while still applying options filter', () => {
    const extracted = extractXDMoviesLinks(SAMPLE_XDMOVIES_HTML, 'https://top.xdmovies.wtf/series/hunkkaar/', {
      targetScope: 'episode',
      targetQuality: '2160p',
    });

    // Filtered links contain only matching scope & quality
    expect(extracted.links.length).toBe(2);
    expect(extracted.links.every((l) => l.scope === 'episode' && l.quality === '2160p')).toBe(true);

    // allLinks preserves both complete season packs AND individual episodes
    expect(extracted.allLinks.length).toBe(4);
    expect(extracted.allLinks.some((l) => l.scope === 'pack')).toBe(true);
    expect(extracted.allLinks.some((l) => l.scope === 'episode')).toBe(true);
    expect(extracted.allLinks.some((l) => l.quality === '1080p')).toBe(true);
  });

  it('matchesQuality accurately recognizes resolutions and synonyms (4K, UHD, FHD, HD, SD)', async () => {
    const { matchesQuality } = await import('../src/utils/normalize.js');

    expect(matchesQuality('2160p', '2160p')).toBe(true);
    expect(matchesQuality('4K HDR', '2160p')).toBe(true);
    expect(matchesQuality('2160p UHD', '2160p')).toBe(true);
    expect(matchesQuality('UHD', '2160p')).toBe(true);
    expect(matchesQuality('1080p', '2160p')).toBe(false);

    expect(matchesQuality('1080p', '1080p')).toBe(true);
    expect(matchesQuality('1080p FHD', '1080p')).toBe(true);
    expect(matchesQuality('FHD', '1080p')).toBe(true);
    expect(matchesQuality('720p', '1080p')).toBe(false);

    expect(matchesQuality('720p', '720p')).toBe(true);
    expect(matchesQuality('720p HD', '720p')).toBe(true);
    expect(matchesQuality('HD', '720p')).toBe(true);
    expect(matchesQuality('1080p', '720p')).toBe(false);

    expect(matchesQuality('480p', '480p')).toBe(true);
    expect(matchesQuality('SD', '480p')).toBe(true);
    expect(matchesQuality('720p', '480p')).toBe(false);

    // 'all' matches everything
    expect(matchesQuality('2160p', 'all')).toBe(true);
    expect(matchesQuality('anything', 'all')).toBe(true);
  });
});

