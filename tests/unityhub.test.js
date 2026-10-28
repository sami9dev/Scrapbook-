import { describe, it, expect } from 'vitest';
import { extractUnityHubMetadata, normalizeUnityHubLink, fetchUnityHubReleases } from '../src/providers/unityhub/parser.js';
import { extractUnityHubLinks } from '../src/providers/unityhub/extractor.js';

const SAMPLE_UNITYHUB_HTML = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>The Family Man — UNiTYhub</title>
  <link rel="canonical" href="https://www.unityhub.buzz/tv/93352-the-family-man" />
  <meta property="og:title" content="The Family Man — UNiTYhub" />
</head>
<body>
  <div id="root"></div>
</body>
</html>
`;

describe('UNiTYhub Provider & Extractor Suite', () => {
  it('accurately extracts TMDB ID and metadata from URL and HTML', () => {
    const metaFromUrl = extractUnityHubMetadata('', 'https://www.unityhub.buzz/tv/93352-the-family-man');
    expect(metaFromUrl.type).toBe('tv');
    expect(metaFromUrl.tmdbId).toBe('93352');
    expect(metaFromUrl.slug).toBe('the-family-man');

    const metaFromMovieUrl = extractUnityHubMetadata('', 'https://www.unityhub.buzz/movie/693134-dune-part-two');
    expect(metaFromMovieUrl.type).toBe('movie');
    expect(metaFromMovieUrl.tmdbId).toBe('693134');

    const metaFromHtml = extractUnityHubMetadata(SAMPLE_UNITYHUB_HTML, '');
    expect(metaFromHtml.type).toBe('tv');
    expect(metaFromHtml.tmdbId).toBe('93352');
    expect(metaFromHtml.title).toBe('The Family Man');
  });

  it('normalizes internal hubcloud.foo URLs to live hubcloud.ist endpoints', () => {
    const input = 'https://hubcloud.foo/video/qwnn7vkxiq4vpzg';
    const output = normalizeUnityHubLink(input);
    expect(output).toBe('https://hubcloud.ist/video/qwnn7vkxiq4vpzg');

    const gdflix = 'https://gdlink.dev/file/5m4mlqMyxFWuPv1';
    expect(normalizeUnityHubLink(gdflix)).toBe(gdflix);
  });

  it('fetches and structures live downloadNodes from UNiTYhub API', async () => {
    try {
      const releases = await fetchUnityHubReleases('93352', 'tv', 'https://www.unityhub.buzz/tv/93352-the-family-man');

      expect(releases.title).toBe('The Family Man');
      expect(releases.type).toBe('tv');
      expect(releases.links.length).toBeGreaterThan(0);

      const packs = releases.links.filter((l) => l.scope === 'pack');
      const episodes = releases.links.filter((l) => l.scope === 'episode');

      expect(packs.length).toBeGreaterThan(0);
      expect(episodes.length).toBeGreaterThan(0);

      // Verify HubCloud episode
      const hubcloudEp = episodes.find((l) => l.provider === 'HUBCLOUD');
      expect(hubcloudEp).toBeDefined();
      expect(hubcloudEp.providerUrl).toContain('hubcloud.ist/video/');
      expect(hubcloudEp.season).toBe(3);
      expect(hubcloudEp.status).toBe('RESOLVED');

      // Verify GDFlix pack
      const gdflixPack = packs.find((l) => l.provider === 'GDFLIX');
      expect(gdflixPack).toBeDefined();
      expect(gdflixPack.providerUrl).toMatch(/gd(link|flix)\.dev/);
      expect(gdflixPack.status).toBe('RESOLVED');
    } catch (err) {
      if (err.message?.includes('fetch failed') || err.message?.includes('timeout') || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        console.warn('Skipping live UNiTYhub test due to remote server timeout');
        return;
      }
      throw err;
    }
  }, 15000);

  it('filters extracted links by targetScope', async () => {
    try {
      const packsOnly = await extractUnityHubLinks(SAMPLE_UNITYHUB_HTML, 'https://www.unityhub.buzz/tv/93352-the-family-man', {
        targetScope: 'pack',
      });
      expect(packsOnly.links.every((l) => l.scope === 'pack')).toBe(true);
      expect(packsOnly.allLinks.some((l) => l.scope === 'episode')).toBe(true);

      const episodesOnly = await extractUnityHubLinks(SAMPLE_UNITYHUB_HTML, 'https://www.unityhub.buzz/tv/93352-the-family-man', {
        targetScope: 'episode',
      });
      expect(episodesOnly.links.every((l) => l.scope === 'episode')).toBe(true);
    } catch (err) {
      if (err.message?.includes('fetch failed') || err.message?.includes('timeout') || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        console.warn('Skipping live UNiTYhub test due to remote server timeout');
        return;
      }
      throw err;
    }
  }, 15000);
});
