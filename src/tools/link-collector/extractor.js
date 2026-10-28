import * as cheerio from 'cheerio';

/**
 * Extracts all hyperlinks from an HTML page string and normalizes them against the base URL.
 *
 * @param {string} html Raw HTML markup.
 * @param {string} baseUrl The URL of the page from which the HTML was fetched.
 * @returns {{ title: string, links: Array<{ url: string, text: string, rel: string }> }}
 */
export function extractPageLinks(html, baseUrl) {
  if (!html || typeof html !== 'string') {
    return { title: '', links: [] };
  }

  const $ = cheerio.load(html);
  const title = $('title').first().text().replace(/\s+/g, ' ').trim() || '';

  const seenUrls = new Set();
  const links = [];

  $('a[href]').each((_, el) => {
    const rawHref = $(el).attr('href')?.trim() || '';
    if (!rawHref) return;

    // Filter out anchors and non-HTTP schemes
    if (
      rawHref.startsWith('#') ||
      rawHref.startsWith('javascript:') ||
      rawHref.startsWith('mailto:') ||
      rawHref.startsWith('tel:') ||
      rawHref.startsWith('data:')
    ) {
      return;
    }

    try {
      const fullUrl = new URL(rawHref, baseUrl).href;
      const parsed = new URL(fullUrl);

      // Only allow HTTP/HTTPS
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return;
      }

      // Filter out self-anchors on the same page
      parsed.hash = '';
      const cleanUrl = parsed.href;

      if (!seenUrls.has(cleanUrl)) {
        seenUrls.add(cleanUrl);
        const linkText = $(el).text().replace(/\s+/g, ' ').trim();
        const rel = $(el).attr('rel') || '';
        links.push({
          url: cleanUrl,
          text: linkText,
          rel,
        });
      }
    } catch {
      // Invalid URL syntax ignored
    }
  });

  return { title, links };
}
