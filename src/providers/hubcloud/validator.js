import { fetchWithControls } from '../../discovery/http-client.js';
import * as cheerio from 'cheerio';

/**
 * Dedicated validation functions for HubCloud destination URLs.
 * Strictly adheres to Section 12 of the 4KHDHub -> Mediator -> HubCloud Resolver specification.
 */

/**
 * Validates whether a URL is a legitimate HubCloud drive destination.
 * Matches:
 *   hostname == "hubcloud.ist" (or configured authorized mirror)
 *   pathname starts with "/drive/"
 * 
 * Never validates by merely checking url.includes("hubcloud").
 * 
 * @param {string} urlString
 * @param {object} [options]
 * @param {string[]} [options.allowedHostnames]
 * @returns {boolean}
 */
export function isHubCloudDriveUrl(urlString, options = {}) {
  if (!urlString || typeof urlString !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(urlString);
    const defaultAllowed = [
      'hubcloud.ist',
      'hubcloud.club',
      'hubcloud.art',
      'hubcloud.fit',
      'hubcloud.one',
      'hubcloud.foo',
      'hubcloud.dev',
      'hubcloud.link',
      'hubcloud.lol',
      'hubcloud.vip',
      'hubcloud.cc',
      'hubcloud.work',
      'hubcloud.to',
      'hubcloud.pw',
      'hubdrive.blog',
      'hubdrive.me',
      'hubdrive.top',
      'hubdrive.pro',
      'hubdrive.link',
    ];
    const allowed = options.allowedHostnames || defaultAllowed;

    const matchesHost = allowed.some((host) => (
      parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    )) || /^(?:[a-z0-9-]+\.)?hubcloud\.[a-z]{2,}$/i.test(parsed.hostname)
       || /^(?:[a-z0-9-]+\.)?hubdrive\.[a-z]{2,}$/i.test(parsed.hostname);

    const matchesPath = parsed.pathname.startsWith('/drive/') || parsed.pathname.startsWith('/file/');

    return matchesHost && matchesPath;
  } catch {
    return false;
  }
}

/**
 * Extracts the dynamic drive ID from a verified HubCloud or HubDrive URL.
 * Example: https://hubcloud.ist/drive/d3vug2udf3bu8iv -> d3vug2udf3bu8iv
 * Example: https://hubcloud.foo/drive/packs/pabwogokpa9zfaf -> pabwogokpa9zfaf
 * Example: https://hubdrive.blog/file/22063887771 -> 22063887771
 * 
 * @param {string} urlString
 * @returns {string|null}
 */
export function extractHubCloudDriveId(urlString) {
  if (!isHubCloudDriveUrl(urlString)) {
    return null;
  }

  try {
    const parsed = new URL(urlString);
    const match = parsed.pathname.match(/^\/(?:drive|file)\/(?:packs\/)?([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Fetches the real filename and metadata directly from the HubCloud destination page.
 * Example: "The Dark Knight (2008) IMAX 2160p UHD BluRay REMUX DV HDR 10bit HEVC..."
 * 
 * @param {string} hubcloudUrl Verified HubCloud drive destination URL
 * @returns {Promise<{ filename: string, title: string, quality?: string }|null>}
 */
export async function fetchHubCloudMetadata(hubcloudUrl, options = {}) {
  if (!isHubCloudDriveUrl(hubcloudUrl)) {
    return null;
  }

  try {
    let target = hubcloudUrl;
    try {
      const u = new URL(hubcloudUrl);
      if (u.hostname !== 'hubcloud.pw' && u.pathname.startsWith('/drive/')) {
        u.hostname = 'hubcloud.pw';
        target = u.toString();
      }
    } catch {}

    const res = await fetchWithControls(target, {
      maxRetries: options.maxRetries ?? 1,
      timeout: options.timeout ?? 6000,
    });
    if (!res.success || !res.body) {
      return null;
    }

    const $ = cheerio.load(res.body);
    const cardHeader = $('.card-header, [class*="bg-primary"]').first().text().trim();
    const docTitle = $('title').text().trim();

    let filename = cardHeader || docTitle || '';

    // Strip generic site notices if present
    filename = filename.replace(/^Notice:\s*Bookmark\s*new\s*domain[^\n]+\n*/i, '').trim();

    // Check for 404 or invalid responses
    if (/404\s*!\s*File\s*Not\s*Found/i.test(res.body) || !filename || /just a moment/i.test(filename)) {
      return null;
    }

    const rawSize = $('#size').first().text().trim() ||
                    (res.body.match(/id=["']size["']>([^<]+)</i)?.[1] || '').trim() ||
                    (res.body.match(/File\s*Size[^>]*>([^<]+)</i)?.[1] || '').trim() ||
                    null;
    const sizeMatch = rawSize ? rawSize.match(/\b([0-9.]+\s*[KMGT]?B)\b/i) : null;
    const fileSize = sizeMatch ? sizeMatch[1] : (rawSize || null);

    return {
      filename,
      title: filename,
      fileSize,
    };
  } catch {
    return null;
  }
}

export default {
  isHubCloudDriveUrl,
  extractHubCloudDriveId,
  fetchHubCloudMetadata,
};
