/**
 * Generic provider parser fallback.
 * Extracts publicly exposed file ID and details when no specific provider parser is registered.
 */
export async function parseGeneric(html, url, options = {}) {
  let fileId = null;

  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    // Typical patterns: /file/:id, /d/:id, /download/:id, or last path segment
    if (pathSegments.length > 0) {
      fileId = pathSegments[pathSegments.length - 1];
    }
  } catch {
    fileId = null;
  }

  return {
    provider: 'GENERIC',
    providerUrl: url,
    fileId,
    filename: null,
    format: null,
    sizeBytes: null,
    sizeDisplay: null,
    mirrors: [],
  };
}

export default parseGeneric;
