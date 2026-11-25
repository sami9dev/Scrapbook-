/**
 * Lightweight HTTP fetcher for XDMovies catalogue pages.
 * Detects Cloudflare / anti-bot gates without launching memory-heavy browsers.
 */

import { logger } from '../../logging/logger.js';

const CHALLENGE_MARKERS = [
  'Just a moment...',
  'cf-turnstile',
  'challenges.cloudflare.com',
  'Attention Required! | Cloudflare',
  'security verification',
];

/**
 * Fetches an XDMovies page over standard HTTPS without launching a browser.
 *
 * @param {string} targetUrl
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<{ ok: boolean, statusCode: number, html: string, challenge: boolean, error?: string }>}
 */
export async function fetchXDMoviesHttp(targetUrl, timeoutMs = 15000) {
  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://huh.xdmovies.wtf/',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = await res.text();
    const lower = body.toLowerCase();
    const isChallenge =
      CHALLENGE_MARKERS.some((m) => lower.includes(m.toLowerCase())) ||
      ((res.status === 403 || res.status === 503) && (lower.includes('cloudflare') || lower.includes('cf-ray') || body.length < 15000));

    logger.log('XDMovies', `[http-fetch] url=${targetUrl} status=${res.status} len=${body.length} challenge=${isChallenge}`);

    if (isChallenge) {
      return {
        ok: false,
        statusCode: res.status,
        html: '',
        challenge: true,
        error: `Target page is gated by a Cloudflare / anti-bot verification challenge (HTTP ${res.status}).`,
      };
    }

    if (!res.ok || body.length < 500) {
      return {
        ok: false,
        statusCode: res.status,
        html: '',
        challenge: false,
        error: `HTTP ${res.status} (body length ${body.length})`,
      };
    }

    return { ok: true, statusCode: res.status, html: body, challenge: false };
  } catch (err) {
    logger.warning(`[XDMovies] [http-fetch] failed for ${targetUrl}: ${err.message}`);
    return { ok: false, statusCode: 0, html: '', challenge: false, error: err.message };
  }
}

export default { fetchXDMoviesHttp };
