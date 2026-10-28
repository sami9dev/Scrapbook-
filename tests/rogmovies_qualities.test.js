import { describe, it, expect } from 'vitest';
import { parseSourcePage } from '../src/sources/source-parser.js';
import '../src/providers/vcloud.js';
import '../src/providers/gdflix.js';

describe('Rogmovies / Multi-Quality Extraction and V-Cloud Prioritization', () => {
  const rogmoviesHtml = `<!DOCTYPE html>
<html lang="en-US">
<head>
<title>Download The Night Manager (Season 1) Hindi DD5.1 Jio-Hotstar Complete Web Series 480p | 720p | 1080p | 2160p 4K WEB-DL | Rogmovies Official</title>
</head>
<body>
<li class="category"><a href="https://rogmovies.one/category/web-series/" rel="category tag">Web Series</a></li>

<h5 style="text-align: center;">The Night Manager S01 <span style="color:yellow;">Hindi</span> WEB-DL 480p x264 [150MB/E]</h5>
<p style="text-align: center;"><a href="https://nexdrive.fit/genxfm784776274470/" target="_blank" rel="noopener"><button class="btn btn-sm btn-outline"><i class="fa fa-download"></i> G-Direct [Instant]</button></a> <a href="https://nexdrive.fit/genxfm784776274472/" target="_blank" rel="noopener"><button class="btn btn-sm btn-outline"><i class="fa fa-download"></i> V-Cloud [Resumable]</button></a> <a href="https://nexdrive.fit/genxfm784776275041/" target="_blank" rel="noopener"><button class="btn btn-sm btn-outline"><i class="fa fa-file-zip-o"></i> Batch/Zip [600MB] </button></a></p>

<h5 style="text-align: center;">The Night Manager S01 <span style="color:yellow;">Hindi</span> WEB-DL 720p x264 [450MB/E]</h5>
<p style="text-align: center;"><a href="https://nexdrive.fit/genxfm784776274581/" target="_blank" rel="noopener"><button class="btn btn-sm btn-outline"><i class="fa fa-download"></i> G-Direct [Instant]</button></a> <a href="https://nexdrive.fit/genxfm784776274583/" target="_blank" rel="noopener"><button class="btn btn-sm btn-outline"><i class="fa fa-download"></i> V-Cloud [Resumable]</button></a> <a href="https://nexdrive.fit/genxfm784776275048/" target="_blank" rel="noopener"><button class="btn btn-sm btn-outline"><i class="fa fa-file-zip-o"></i> Batch/Zip [1.8GB] </button></a></p>

<h5 style="text-align: center;">The Night Manager S01 <span style="color:yellow;">Hindi</span> WEB-DL 1080p x264 [1.5GB/E]</h5>
<p style="text-align: center;"><a href="https://nexdrive.fit/genxfm784776274422/" target="_blank" rel="noopener"><button class="btn btn-sm btn-outline"><i class="fa fa-download"></i> V-Cloud [Resumable]</button></a> <a href="https://nexdrive.fit/genxfm784776275052/" target="_blank" rel="noopener"><button class="btn btn-sm btn-outline"><i class="fa fa-file-zip-o"></i> Batch/Zip [5.3GB] </button></a></p>

<h5 style="text-align: center;">The Night Manager S01 <span style="color:yellow;">Hindi</span> WEB-DL 2160p 4K H.265 [6GB/E]</h5>
<p style="text-align: center;"><a href="https://nexdrive.fit/genxfm784776274427/" target="_blank" rel="noopener"><button class="btn btn-sm btn-outline"><i class="fa fa-download"></i> V-Cloud [Resumable]</button></a></p>
</body>
</html>`;

  it('scrapes all 4 qualities (480p, 720p, 1080p, 2160p) and preserves batch packs', () => {
    const result = parseSourcePage(rogmoviesHtml, 'https://rogmovies.one/download-the-night-manager-season-1-hindi-series-480p-720p-1080p-2160p-web-dl/');

    // Expected 7 links: (480p V-Cloud + Batch), (720p V-Cloud + Batch), (1080p V-Cloud + Batch), (2160p V-Cloud)
    expect(result.discoveredLinks).toHaveLength(7);

    // Verify all 4 qualities are present
    const qualities = [...new Set(result.discoveredLinks.map((l) => l.quality))];
    expect(qualities).toContain('480p');
    expect(qualities).toContain('720p');
    expect(qualities).toContain('1080p');
    expect(qualities).toContain('2160p');

    // Verify V-Cloud is prioritized over G-Direct for 480p and 720p
    const hasGDirect = result.discoveredLinks.some((l) => /4470|4581/i.test(l.resolvedUrl));
    expect(hasGDirect).toBe(false);

    // Verify V-Cloud links are present for all tiers
    const vcloudLinks = result.discoveredLinks.filter((l) => /4472|4583|4422|4427/i.test(l.resolvedUrl));
    expect(vcloudLinks).toHaveLength(4);

    // Verify Batch packs are preserved with scope 'pack'
    const batchPacks = result.discoveredLinks.filter((l) => l.scope === 'pack');
    expect(batchPacks).toHaveLength(3);
    expect(batchPacks.map((b) => b.quality)).toEqual(['480p', '720p', '1080p']);

    // Verify all returned Nexdrive links use the canonical https://nexdrive.beer/genxfm domain
    for (const link of result.discoveredLinks) {
      expect(link.resolvedUrl).toMatch(/^https:\/\/nexdrive\.beer\/genxfm/);
      expect(link.resolvedUrl).not.toContain('nexdrive.fit');
    }

    // Verify codecs are extracted from headers
    const link2160p = result.discoveredLinks.find((l) => l.quality === '2160p');
    expect(link2160p.codec).toBe('H.265');
    expect(link2160p.sizeDisplay).toBe('6GB');

    const link480p = result.discoveredLinks.find((l) => l.quality === '480p' && l.scope === 'episode');
    expect(link480p.codec).toBe('H.264');
    expect(link480p.sizeDisplay).toBe('150MB');
  });

  it('always normalizes Nexdrive mirror URLs to canonical https://nexdrive.beer/genxfm', () => {
    const result = parseSourcePage(rogmoviesHtml, 'https://rogmovies.one/download-the-night-manager-season-1-hindi-series-480p-720p-1080p-2160p-web-dl/');

    expect(result.discoveredLinks.length).toBe(7);
    for (const link of result.discoveredLinks) {
      expect(link.resolvedUrl).toMatch(/^https:\/\/nexdrive\.beer\/genxfm/);
    }
  });

  it('filters out WordPress taxonomy and category links', () => {
    const result = parseSourcePage(rogmoviesHtml, 'https://rogmovies.one/download-the-night-manager-season-1-hindi-series-480p-720p-1080p-2160p-web-dl/');
    const hasCategory = result.discoveredLinks.some((l) => /category/i.test(l.resolvedUrl));
    expect(hasCategory).toBe(false);
  });
});

