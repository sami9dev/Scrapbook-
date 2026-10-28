import { describe, it, expect } from 'vitest';
import { parseSourcePage } from '../src/sources/source-parser.js';
import '../src/providers/vcloud.js';
import '../src/providers/gdflix.js';

describe('Nexdrive / V-Cloud Priority Policy', () => {
  const nexdriveHtml = `<!DOCTYPE html>
<html class="no-js" lang="en-US">
<head>
<title>The Night Manager (Season 1) HS WEB-DL Hindi DDP5.1 Atmos 2160p H.265 [6GB/E] = [V-Cloud] &#8211; Nexdrive.Beer</title>
</head>
<body>
<li class="category"><a href="https://nexdrive.beer/genxfm784776category/uncategorized/" rel="category tag">Uncategorized</a></li>
<h4>-:Episodes: 1:-</h4>
<p><a href="https://vcloud.beer/yx8zfrldolv8lxq" target="_blank"><button class="btn btn-sm btn-outline">V-Cloud [Resumable]</button></a> <a href="https://filebee.xyz/file/63ee7a253574fd4e040f48bf" target="_blank"><button class="btn btn-sm btn-outline">G-Drive [Login]</button></a></p>
<hr>
<h4>-:Episodes: 2:-</h4>
<p><a href="https://filebee.xyz/file/63ee7a253574fd4e040f48db" target="_blank"><button class="btn btn-sm btn-outline">G-Drive [Login]</button></a> <a href="https://vcloud.beer/3t51y3jhjxqitl9" target="_blank"><button class="btn btn-sm btn-outline">V-Cloud [Resumable]</button></a></p>
<hr>
<h4>-:Episodes: 3:-</h4>
<p><a href="https://vcloud.beer/getlgvrle1rgrqq" target="_blank"><button class="btn btn-sm btn-outline">V-Cloud [Resumable]</button></a> <a href="https://filebee.xyz/file/63ee7a263574fd4e040f4903" target="_blank"><button class="btn btn-sm btn-outline">G-Drive [Login]</button></a></p>
<hr>
<h4>-:Episodes: 4:-</h4>
<p><a href="https://vcloud.beer/kdgwg1lz8huqm5k" target="_blank"><button class="btn btn-sm btn-outline">V-Cloud [Resumable]</button></a> <a href="https://filebee.xyz/file/63ee7a263574fd4e040f491f" target="_blank"><button class="btn btn-sm btn-outline">G-Drive [Login]</button></a></p>
<hr>
<h4>-:Episodes: 5:-</h4>
<p><a href="https://vcloud.beer/vrpy9d09co19nk2" target="_blank"><button class="btn btn-sm btn-outline">V-Cloud [Resumable]</button></a> <a href="https://filebee.xyz/file/6a14acf5316785aa8207f988" target="_blank"><button class="btn btn-sm btn-outline">Filepress [G-Drive]</button></a></p>
<hr>
<h4>-:Episodes: 6:-</h4>
<p><a href="https://vcloud.beer/d11xy1v-g1hhhev" target="_blank"><button class="btn btn-sm btn-outline">V-Cloud [Resumable]</button></a> <a href="https://filebee.xyz/file/6a14a9a2316785aa820795e2" target="_blank"><button class="btn btn-sm btn-outline">Filepress [G-Drive]</button></a></p>
<hr>
<h4>-:Episodes: 7:-</h4>
<p><a href="https://vcloud.beer/ecv6mguldeddpvt" target="_blank"><button class="btn btn-sm btn-outline">V-Cloud [Resumable]</button></a> <a href="https://filebee.xyz/file/6a14aba2316785aa8207d2af" target="_blank"><button class="btn btn-sm btn-outline">Filepress [G-Drive]</button></a></p>
</body>
</html>`;

  it('always returns V-Cloud links when both V-Cloud and Filebee exist', () => {
    const result = parseSourcePage(nexdriveHtml, 'https://nexdrive.beer/genxfm784776274427/');

    expect(result.discoveredLinks).toHaveLength(7);

    // Ensure all 7 links are V-Cloud
    const allAreVCloud = result.discoveredLinks.every(
      (l) => l.provider === 'V-Cloud' || /vcloud\.beer/i.test(l.resolvedUrl)
    );
    expect(allAreVCloud).toBe(true);

    // Ensure no Filebee links replaced V-Cloud
    const hasFilebee = result.discoveredLinks.some((l) => /filebee/i.test(l.resolvedUrl));
    expect(hasFilebee).toBe(false);

    // Verify correct 1..7 episode mapping (no S01E02 duplication)
    const episodes = result.discoveredLinks.map((l) => l.episode);
    expect(episodes).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Verify exact expected URLs
    expect(result.discoveredLinks[0].resolvedUrl).toBe('https://vcloud.beer/yx8zfrldolv8lxq');
    expect(result.discoveredLinks[1].resolvedUrl).toBe('https://vcloud.beer/3t51y3jhjxqitl9');
    expect(result.discoveredLinks[6].resolvedUrl).toBe('https://vcloud.beer/ecv6mguldeddpvt');
  });

  it('filters out WordPress taxonomy and category links', () => {
    const result = parseSourcePage(nexdriveHtml, 'https://nexdrive.beer/genxfm784776274427/');
    const hasCategoryLink = result.discoveredLinks.some((l) => /category|uncategorized/i.test(l.resolvedUrl));
    expect(hasCategoryLink).toBe(false);
  });
});
