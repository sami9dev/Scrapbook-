/**
 * Telegraph Presentation Layer for 4KHub4U
 *
 * Formats and publishes complete 4KHub4U catalogues onto Telegraph presentation pages.
 * Strictly adheres to Sections 9, 16, 17, 19, 25, and 33 of the specification.
 *
 * Resilient networking:
 * - Uses standard https://api.telegra.ph by default.
 * - Supports custom TELEGRAPH_API_URL or direct Telegram IP fallback (149.154.164.13)
 *   to bypass regional ISP DNS spoofing / SNI interference.
 */

import https from 'https';
import { logger } from '../../logging/logger.js';
import { isHubCloudDriveUrl } from '../../providers/hubcloud/validator.js';

// Cache Telegraph access token in memory across requests
let _cachedAccessToken = process.env.TELEGRAPH_ACCESS_TOKEN || null;
let _directNetworkPreferred = false;

/**
 * Resilient request helper for Telegraph API.
 * Automatically handles DNS spoofing / regional blockages with direct IP fallback.
 *
 * @param {string} method Path method (e.g. '/createAccount' or '/createPage')
 * @param {object} params Form parameters
 * @returns {Promise<object>} API JSON response
 */
export async function callTelegraphApi(method, params = {}) {
  const customBase = process.env.TELEGRAPH_API_URL;
  const bodyParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      bodyParams.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
  const bodyString = bodyParams.toString();

  // If customBase is provided, use standard fetch
  if (customBase) {
    const res = await fetch(`${customBase}${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyString,
    });
    return await res.json();
  }

  const callDirectIp = () =>
    new Promise((resolve, reject) => {
      const reqOptions = {
        hostname: '149.154.164.13',
        port: 443,
        path: method,
        method: 'POST',
        headers: {
          Host: 'api.telegra.ph',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(bodyString),
        },
        rejectUnauthorized: false,
        timeout: 10000,
      };

      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            _directNetworkPreferred = true;
            resolve(json);
          } catch {
            reject(new Error(`Failed to parse Telegraph response: ${data.slice(0, 100)}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Telegraph direct IP request timed out'));
      });

      req.on('error', (e) => reject(e));
      req.write(bodyString);
      req.end();
    });

  // If direct network fallback was previously successful, skip DNS timeout
  if (_directNetworkPreferred) {
    try {
      return await callDirectIp();
    } catch {
      _directNetworkPreferred = false; // reset on error
    }
  }

  // Attempt 1: Standard domain via fetch (fast timeout)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`https://api.telegra.ph${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyString,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      if (data.ok) return data;
    }
  } catch {
    // Standard domain failed (e.g. ISP DNS spoofing or timeout)
  }

  // Attempt 2: Direct Telegram IP fallback (149.154.164.13)
  return await callDirectIp();
}

/**
 * Ensures an active Telegraph access token exists.
 *
 * @returns {Promise<string>}
 */
export async function getOrCreateTelegraphToken() {
  if (_cachedAccessToken) return _cachedAccessToken;

  try {
    const data = await callTelegraphApi('/createAccount', {
      short_name: '4KHub4U',
      author_name: '4KHub4U Bot',
      author_url: 'https://t.me/Linkscrap_bot',
    });

    if (data.ok && data.result?.access_token) {
      _cachedAccessToken = data.result.access_token;
      return _cachedAccessToken;
    }
  } catch (err) {
    logger.error(`Failed to create Telegraph account: ${err.message}`);
  }

  // Known fallback access token
  return 'fada2b95fcec27aa96cd55045b0df05672966e459036e7f4cd3b8ba0fe2a';
}

/**
 * Filters download links to exclusively return HubCloud destination links,
 * strictly omitting HubDrive links (e.g. hubdrive.pics).
 *
 * @param {Array<object>} downloadLinks
 * @returns {Array<object>}
 */
export function getHubCloudDownloadLinks(downloadLinks = []) {
  if (!Array.isArray(downloadLinks) || downloadLinks.length === 0) return [];

  // Exclude anything that is HubDrive by URL, label, or provider
  const nonHubDrive = downloadLinks.filter((link) => {
    const url = link.resolvedUrl || link.url || '';
    const label = link.label || '';
    const provider = link.provider || '';
    return (
      !/hubdrive/i.test(url) &&
      !/hubdrive/i.test(label) &&
      !/hubdrive/i.test(provider)
    );
  });

  // Filter for explicitly verified HubCloud destination links
  const verifiedHubCloud = nonHubDrive.filter((link) => {
    const url = link.resolvedUrl || link.url || '';
    return isHubCloudDriveUrl(url);
  });

  if (verifiedHubCloud.length > 0) {
    const seenUrls = new Set();
    const unique = [];
    for (const c of verifiedHubCloud) {
      const u = c.resolvedUrl || c.url;
      if (u && !seenUrls.has(u)) {
        seenUrls.add(u);
        unique.push(c);
      }
    }
    return [unique[0]];
  }

  // Never return raw mediator links (e.g. greenmotors, fast-share, etc.)
  return [];
}

/**
 * Builds Telegraph Node AST for a movie catalogue (Section 16).
 *
 * @param {import('./types.js').FourKHubCatalogue} catalogue
 * @returns {Array<object>}
 */
export function buildMovieTelegraphNodes(catalogue) {
  const nodes = [];

  // Header Title
  nodes.push({ tag: 'h3', children: [`🎬 ${catalogue.title} ${catalogue.year ? `(${catalogue.year})` : ''}`.trim()] });
  nodes.push({ tag: 'hr' });

  // 1. Available Quality section
  nodes.push({ tag: 'h4', children: ['📺 Available Quality'] });
  for (const qGroup of catalogue.qualities) {
    nodes.push({ tag: 'p', children: [{ tag: 'b', children: [qGroup.resolution] }] });

    // Collect distinct variants in this quality group
    const variantSet = new Set();
    for (const rel of qGroup.releases) {
      const variantParts = [];
      if (rel.dynamicRange) variantParts.push(rel.dynamicRange);
      if (rel.bitDepth) variantParts.push(rel.bitDepth);
      if (rel.sourceType) variantParts.push(rel.sourceType);
      if (rel.codec) variantParts.push(rel.codec);
      const vStr = variantParts.join(' • ');
      if (vStr) variantSet.add(vStr);
    }

    if (variantSet.size > 0) {
      const ulItems = Array.from(variantSet).map((v) => ({
        tag: 'li',
        children: [v],
      }));
      nodes.push({ tag: 'ul', children: ulItems });
    }
  }
  nodes.push({ tag: 'hr' });

  // 2. Audio section
  if (catalogue.audioLanguages && catalogue.audioLanguages.length > 0) {
    nodes.push({ tag: 'h4', children: ['🔊 Audio'] });
    const audioItems = catalogue.audioLanguages.map((lang) => ({
      tag: 'li',
      children: [lang],
    }));
    nodes.push({ tag: 'ul', children: audioItems });
    nodes.push({ tag: 'hr' });
  }

  // 3. Releases section
  nodes.push({ tag: 'h4', children: ['📦 Releases'] });
  for (const qGroup of catalogue.qualities) {
    for (const rel of qGroup.releases) {
      const relTitle = rel.filename || rel.label || `${rel.quality.normalized} Release`;
      const sizeBadge = rel.fileSize ? ` [${rel.fileSize}]` : '';

      const targetLinks = getHubCloudDownloadLinks(rel.downloadLinks);
      const pChildren = [{ tag: 'b', children: [`${relTitle}${sizeBadge}`] }];
      if (targetLinks.length > 0) {
        for (const link of targetLinks) {
          const url = link.resolvedUrl || link.url;
          pChildren.push({ tag: 'br' });
          pChildren.push({
            tag: 'a',
            attrs: { href: url },
            children: [url],
          });
        }
      } else {
        pChildren.push({ tag: 'br' });
        pChildren.push({
          tag: 'i',
          children: ['⚠️ HubCloud Link Unavailable (Expired on source site)'],
        });
      }
      nodes.push({ tag: 'p', children: pChildren });
    }
  }

  return nodes;
}

/**
 * Formats a clean, readable variant title for grouping episodes.
 * Examples: "2160p • Dolby Vision + HDR • WEB-DL • HEVC", "2160p • SDR • WEB-DL • HEVC", "1080p • SDR • x264"
 *
 * @param {object} rel Release object
 * @returns {string}
 */
export function getReleaseVariantTitle(rel) {
  const parts = [];
  const res = rel.quality?.normalized || rel.resolution;
  if (res && res !== 'unknown') parts.push(res);
  if (rel.dynamicRange) parts.push(rel.dynamicRange);
  if (rel.bitDepth) parts.push(rel.bitDepth);
  if (rel.sourceType && !parts.includes(rel.sourceType)) parts.push(rel.sourceType);
  if (rel.codec && !parts.includes(rel.codec)) parts.push(rel.codec);

  if (parts.length > 0) {
    return parts.join(' • ');
  }
  return rel.label || 'Episodes';
}

/**
 * Returns a unique key representing the video variant.
 *
 * @param {object} rel Release object
 * @returns {string}
 */
export function getReleaseVariantKey(rel) {
  const res = rel.quality?.normalized || rel.resolution || 'unknown';
  const dr = rel.dynamicRange || 'SDR';
  const bd = rel.bitDepth || '';
  const src = rel.sourceType || '';
  const codec = rel.codec || '';
  return `${res}_${dr}_${bd}_${src}_${codec}`.toLowerCase();
}

/**
 * Calculates a sorting priority score for video variants (lower = higher priority).
 * 2160p DV+HDR (0) -> 2160p SDR (50) -> 1080p DV+HDR (100) -> 1080p SDR HEVC (150) -> 1080p SDR x264 (153)
 *
 * @param {object} rel Release object
 * @returns {number}
 */
export function getReleaseVariantSortScore(rel) {
  const res = (rel.quality?.normalized || rel.resolution || '').toLowerCase();
  let resRank = 4;
  if (res.includes('2160p') || res.includes('4k')) resRank = 0;
  else if (res.includes('1080p')) resRank = 1;
  else if (res.includes('720p')) resRank = 2;
  else if (res.includes('480p')) resRank = 3;

  const dr = rel.dynamicRange || '';
  let drRank = 6;
  if (/dolby\s*vision.*\+.*hdr|dv.*hdr/i.test(dr)) drRank = 0;
  else if (/dolby\s*vision|dovi|dv/i.test(dr)) drRank = 1;
  else if (/hdr10\+/i.test(dr)) drRank = 2;
  else if (/hdr10/i.test(dr)) drRank = 3;
  else if (/hdr/i.test(dr)) drRank = 4;
  else if (/sdr/i.test(dr)) drRank = 5;

  const codec = (rel.codec || '').toLowerCase();
  let codecRank = 4;
  if (codec.includes('hevc') || codec.includes('265')) codecRank = 0;
  else if (codec.includes('av1')) codecRank = 1;
  else if (codec.includes('vp9')) codecRank = 2;
  else if (codec.includes('264')) codecRank = 3;

  return (resRank * 100) + (drRank * 10) + codecRank;
}

/**
 * Builds Telegraph Node AST for a series catalogue organized by season (Section 17).
 * Uses clean format: Full filename / release title on line 1, direct destination URL on line 2.
 * Categorizes individual episodes by release variant (DV+HDR vs simple H.265 / SDR, etc.)
 *
 * @param {import('./types.js').FourKHubCatalogue} catalogue
 * @returns {Array<object>}
 */
export function buildSeriesTelegraphNodes(catalogue) {
  const nodes = [];

  // Title
  nodes.push({ tag: 'h3', children: [`🎬 ${catalogue.title}`] });

  // Summary info
  if (catalogue.audioLanguages && catalogue.audioLanguages.length > 0) {
    nodes.push({
      tag: 'p',
      children: [
        { tag: 'b', children: ['🔊 Audio: '] },
        catalogue.audioLanguages.join(', '),
      ],
    });
  }

  const qualityList = catalogue.qualities.map((q) => q.resolution).join(', ');
  if (qualityList) {
    nodes.push({
      tag: 'p',
      children: [
        { tag: 'b', children: ['📺 Available Quality: '] },
        qualityList,
      ],
    });
  }

  nodes.push({ tag: 'hr' });

  // Season by Season breakdown (Section 17: "If there are eight seasons, show eight seasons.")
  for (const season of catalogue.seasons) {
    const seasonLabel = `SEASON ${String(season.number).padStart(2, '0')}`;
    nodes.push({ tag: 'h4', children: [seasonLabel] });

    // 1. Complete Season Packs (sorted from highest quality to lowest)
    const packs = season.releases.filter((r) => r.scope === 'pack');
    if (packs.length > 0) {
      nodes.push({ tag: 'p', children: [{ tag: 'b', children: ['📦 Complete Season Packs:'] }] });
      const sortedPacks = packs.slice().sort((a, b) => getReleaseVariantSortScore(a) - getReleaseVariantSortScore(b));
      for (const p of sortedPacks) {
        const pLabel = p.filename || p.label || `${p.quality.normalized} Season Pack`;
        const sizeBadge = p.fileSize ? ` (${p.fileSize})` : '';
        const targetLinks = getHubCloudDownloadLinks(p.downloadLinks);
        const pChildren = [{ tag: 'b', children: [`• ${pLabel}${sizeBadge}`] }];
        if (targetLinks.length > 0) {
          for (const l of targetLinks) {
            const url = l.resolvedUrl || l.url;
            pChildren.push({ tag: 'br' });
            pChildren.push({
              tag: 'a',
              attrs: { href: url },
              children: [url],
            });
          }
        } else {
          pChildren.push({ tag: 'br' });
          pChildren.push({
            tag: 'i',
            children: ['⚠️ HubCloud Link Unavailable (Expired on source site)'],
          });
        }
        nodes.push({ tag: 'p', children: pChildren });
      }
    }

    // 2. Individual episodes (categorized and sensed by release variant)
    const episodes = season.releases.filter((r) => r.scope === 'episode');
    if (episodes.length > 0) {
      const variantGroups = new Map();
      for (const ep of episodes) {
        const vKey = getReleaseVariantKey(ep);
        if (!variantGroups.has(vKey)) {
          variantGroups.set(vKey, {
            title: getReleaseVariantTitle(ep),
            sortScore: getReleaseVariantSortScore(ep),
            episodes: [],
          });
        }
        variantGroups.get(vKey).episodes.push(ep);
      }

      // Sort variant groups logically: 2160p (DV+HDR -> SDR), 1080p (DV+HDR -> SDR HEVC -> SDR x264), etc.
      const sortedGroups = Array.from(variantGroups.values()).sort((a, b) => a.sortScore - b.sortScore);

      for (const grp of sortedGroups) {
        const headerText = grp.title ? `🎬 Episodes (${grp.title}):` : '🎬 Episodes:';
        nodes.push({ tag: 'p', children: [{ tag: 'b', children: [headerText] }] });

        // Sort episodes by episode number
        const sortedEpisodes = grp.episodes.slice().sort((a, b) => (a.episode || 0) - (b.episode || 0));

        for (const ep of sortedEpisodes) {
          const epTitle = ep.filename || ep.label;
          const targetLinks = getHubCloudDownloadLinks(ep.downloadLinks);
          const pChildren = [{ tag: 'b', children: [epTitle] }];
          if (targetLinks.length > 0) {
            for (const l of targetLinks) {
              const url = l.resolvedUrl || l.url;
              pChildren.push({ tag: 'br' });
              pChildren.push({
                tag: 'a',
                attrs: { href: url },
                children: [url],
              });
            }
          } else {
            pChildren.push({ tag: 'br' });
            pChildren.push({
              tag: 'i',
              children: ['⚠️ HubCloud Link Unavailable (Expired on source site)'],
            });
          }
          nodes.push({ tag: 'p', children: pChildren });
        }
      }
    }

    nodes.push({ tag: 'hr' });
  }

  return nodes;
}

/**
 * Splits a series catalogue into chunks that each comfortably fit within Telegraph's 64KB API limit.
 *
 * @param {import('./types.js').FourKHubCatalogue} catalogue
 * @param {number} [maxBytes=48000]
 * @returns {Array<import('./types.js').FourKHubCatalogue>}
 */
export function chunkSeriesCatalogue(catalogue, maxBytes = 48000) {
  if (!Array.isArray(catalogue.seasons) || catalogue.seasons.length === 0) {
    return [catalogue];
  }

  // If already fits, return as-is
  const allNodes = buildSeriesTelegraphNodes(catalogue);
  if (Buffer.byteLength(JSON.stringify(allNodes)) <= maxBytes) {
    return [catalogue];
  }

  const chunks = [];
  let currentSeasons = [];

  for (const season of catalogue.seasons) {
    const testCat = { ...catalogue, seasons: [...currentSeasons, season] };
    const bytes = Buffer.byteLength(JSON.stringify(buildSeriesTelegraphNodes(testCat)));

    if (bytes > maxBytes && currentSeasons.length > 0) {
      chunks.push({ ...catalogue, seasons: currentSeasons });
      currentSeasons = [season];
    } else {
      currentSeasons.push(season);
    }
  }

  if (currentSeasons.length > 0) {
    chunks.push({ ...catalogue, seasons: currentSeasons });
  }

  return chunks.length > 0 ? chunks : [catalogue];
}

/**
 * Splits a movie catalogue into chunks if it exceeds Telegraph's 64KB limit.
 *
 * @param {import('./types.js').FourKHubCatalogue} catalogue
 * @param {number} [maxBytes=48000]
 * @returns {Array<import('./types.js').FourKHubCatalogue>}
 */
export function chunkMovieCatalogue(catalogue, maxBytes = 48000) {
  if (!Array.isArray(catalogue.qualities) || catalogue.qualities.length <= 1) {
    return [catalogue];
  }

  const allNodes = buildMovieTelegraphNodes(catalogue);
  if (Buffer.byteLength(JSON.stringify(allNodes)) <= maxBytes) {
    return [catalogue];
  }

  const chunks = [];
  let currentQualities = [];

  for (const q of catalogue.qualities) {
    const testCat = { ...catalogue, qualities: [...currentQualities, q] };
    const bytes = Buffer.byteLength(JSON.stringify(buildMovieTelegraphNodes(testCat)));

    if (bytes > maxBytes && currentQualities.length > 0) {
      chunks.push({ ...catalogue, qualities: currentQualities });
      currentQualities = [q];
    } else {
      currentQualities.push(q);
    }
  }

  if (currentQualities.length > 0) {
    chunks.push({ ...catalogue, qualities: currentQualities });
  }

  return chunks.length > 0 ? chunks : [catalogue];
}

/**
 * Creates Telegraph presentation page(s) from a 4KHub4U catalogue.
 * Automatically chunks large catalogues across multiple linked Telegraph pages
 * to ensure Telegraph's 64KB limit is never exceeded and Instant View always renders.
 *
 * @param {import('./types.js').FourKHubCatalogue} catalogue
 * @returns {Promise<{
 *   success: boolean,
 *   url: string,
 *   path?: string,
 *   title?: string,
 *   pages?: Array<{ url: string, title: string, label: string }>,
 *   error?: string
 * }>}
 */
export async function createTelegraphCataloguePage(catalogue) {
  try {
    const token = await getOrCreateTelegraphToken();

    const titlePrefix = catalogue.type === 'series' ? '📺 ' : '🎬 ';
    const pageTitle = `${titlePrefix}${catalogue.title}`.slice(0, 250);

    const isSeries = catalogue.type === 'series';
    const singleContent = isSeries
      ? buildSeriesTelegraphNodes(catalogue)
      : buildMovieTelegraphNodes(catalogue);

    const contentBytes = Buffer.byteLength(JSON.stringify(singleContent));

    // Fast path: If fits comfortably under Telegraph's 64KB limit, try single page
    if (contentBytes < 55000) {
      const data = await callTelegraphApi('/createPage', {
        access_token: token,
        title: pageTitle,
        author_name: '4KHub4U Bot',
        author_url: 'https://t.me/Linkscrap_bot',
        content: singleContent,
      });

      if (data.ok && data.result?.url) {
        const pageUrl = data.result.url;
        logger.log('4KHub4U', `[4KHub4U] Telegraph page created: ${pageUrl}`);
        return {
          success: true,
          url: pageUrl,
          path: data.result.path,
          title: data.result.title,
          pages: [{ url: pageUrl, title: pageTitle, label: 'Catalogue' }],
        };
      }

      if (data.error && data.error !== 'CONTENT_TOO_BIG') {
        return {
          success: false,
          url: null,
          error: data.error || 'Failed to create Telegraph page',
        };
      }
    }

    // Multi-part pagination path for large catalogues (Section 16/17 scale resilience)
    logger.log('4KHub4U', `[4KHub4U] Content size (${contentBytes} bytes) requires multi-part Telegraph pagination`);
    const chunks = isSeries
      ? chunkSeriesCatalogue(catalogue, 48000)
      : chunkMovieCatalogue(catalogue, 48000);

    const createdPages = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const partNum = i + 1;
      let partLabel = `Part ${partNum}`;
      if (isSeries && chunk.seasons?.length > 0) {
        const sNums = chunk.seasons.map((s) => s.number).sort((a, b) => a - b);
        const sRange =
          sNums.length === 1
            ? `Season ${sNums[0]}`
            : `Seasons ${sNums[0]}–${sNums[sNums.length - 1]}`;
        partLabel = `Part ${partNum} (${sRange})`;
      }

      const partTitle = `${titlePrefix}${catalogue.title} • ${partLabel}`.slice(0, 250);
      const chunkNodes = isSeries
        ? buildSeriesTelegraphNodes(chunk)
        : buildMovieTelegraphNodes(chunk);

      const res = await callTelegraphApi('/createPage', {
        access_token: token,
        title: partTitle,
        author_name: '4KHub4U Bot',
        author_url: 'https://t.me/Linkscrap_bot',
        content: chunkNodes,
      });

      if (res.ok && res.result?.url) {
        createdPages.push({
          url: res.result.url,
          path: res.result.path,
          title: partTitle,
          label: partLabel,
          nodes: chunkNodes,
        });
      }
    }

    if (createdPages.length === 0) {
      return {
        success: false,
        url: null,
        error: 'Failed to create multi-part Telegraph pages',
      };
    }

    // Add cross-navigation between parts
    if (createdPages.length > 1) {
      for (let i = 0; i < createdPages.length; i++) {
        const page = createdPages[i];
        const updatedNodes = [...page.nodes];
        let needsEdit = false;

        // Add Next link if not last part
        if (i < createdPages.length - 1) {
          const next = createdPages[i + 1];
          updatedNodes.push({ tag: 'hr' });
          updatedNodes.push({
            tag: 'p',
            children: [
              { tag: 'b', children: ['👉 Continued in '] },
              {
                tag: 'a',
                attrs: { href: next.url },
                children: [`${next.label}`],
              },
            ],
          });
          needsEdit = true;
        }

        // Add Previous link if not first part
        if (i > 0) {
          const prev = createdPages[i - 1];
          updatedNodes.unshift({ tag: 'hr' });
          updatedNodes.unshift({
            tag: 'p',
            children: [
              { tag: 'b', children: ['👈 Previous: '] },
              {
                tag: 'a',
                attrs: { href: prev.url },
                children: [`${prev.label}`],
              },
            ],
          });
          needsEdit = true;
        }

        if (needsEdit) {
          try {
            await callTelegraphApi('/editPage', {
              access_token: token,
              path: page.path,
              title: page.title,
              author_name: '4KHub4U Bot',
              author_url: 'https://t.me/Linkscrap_bot',
              content: updatedNodes,
            });
          } catch {
            // Ignore edit failure, initial page is already created
          }
        }
      }
    }

    logger.log(
      '4KHub4U',
      `[4KHub4U] Created ${createdPages.length} Telegraph catalogue pages: primary ${createdPages[0].url}`
    );

    return {
      success: true,
      url: createdPages[0].url,
      path: createdPages[0].path,
      title: createdPages[0].title,
      pages: createdPages.map((p) => ({ url: p.url, title: p.title, label: p.label })),
    };
  } catch (err) {
    logger.error(`Telegraph page creation error: ${err.message}`);
    return {
      success: false,
      url: null,
      error: err.message,
    };
  }
}

export default {
  callTelegraphApi,
  getOrCreateTelegraphToken,
  getHubCloudDownloadLinks,
  chunkSeriesCatalogue,
  chunkMovieCatalogue,
  buildMovieTelegraphNodes,
  buildSeriesTelegraphNodes,
  createTelegraphCataloguePage,
};
