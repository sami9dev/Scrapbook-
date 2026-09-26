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
    const allowed = options.allowedHostnames || ['hubcloud.ist', 'hubcloud.club', 'hubcloud.art', 'hubcloud.fit', 'hubcloud.one'];

    const matchesHost = allowed.some((host) => (
      parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    ));

    const matchesPath = parsed.pathname.startsWith('/drive/');

    return matchesHost && matchesPath;
  } catch {
    return false;
  }
}

/**
 * Extracts the dynamic drive ID from a verified HubCloud URL.
 * Example: https://hubcloud.ist/drive/d3vug2udf3bu8iv -> d3vug2udf3bu8iv
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
    const match = parsed.pathname.match(/^\/drive\/([a-zA-Z0-9_-]+)/);
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
export async function fetchHubCloudMetadata(hubcloudUrl) {
  if (!isHubCloudDriveUrl(hubcloudUrl)) {
    return null;
  }

  try {
    const res = await fetchWithControls(hubcloudUrl);
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

    return {
      filename,
      title: filename,
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
