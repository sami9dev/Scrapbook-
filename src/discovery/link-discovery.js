import { parseHtml } from '../parsing/html-parser.js';
import { providerRegistry } from '../providers/provider-registry.js';
import { resolveRelativeUrl } from '../utils/url.js';
import { logger } from '../logging/logger.js';

/**
 * Extracts opaque tokens (e.g. ?file=eyJ... or ?token=...) from a URL without decoding them.
 * Per section 7: treat tokens as opaque identifiers.
 * 
 * @param {string} url
 * @returns {string|null}
 */
export function extractOpaqueToken(url) {
  if (!url || typeof url !== 'string') return null;

  try {
    const parsed = new URL(url);
    const searchParams = parsed.searchParams;
    for (const key of ['file', 'token', 'code', 'data', 'auth']) {
      const val = searchParams.get(key);
      if (val && val.length > 8) {
        return val;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Discovers publicly exposed destination links on intermediate pages.
 * Inspects:
 * - <a href> matching registered providers or download triggers
 * - <form action>
 * - Canonical URL
 * - Meta refresh tags
 * - JSON embedded in the page / JSON-LD
 * 
 * NEVER attempts to reverse or decrypt tokens or bypass protections.
 * If challenge encountered: returns HUMAN_VERIFICATION_REQUIRED.
 * 
 * @param {string} html - HTML of intermediate page
 * @param {string} pageUrl - URL of intermediate page
 * @returns {object}
 */
export function discoverExposedDestination(html, pageUrl) {
  const parsed = parseHtml(html, pageUrl);

  // 1. If human verification challenge detected, stop immediately
  if (parsed.challenge) {
    return {
      status: 'HUMAN_VERIFICATION_REQUIRED',
      destinationUrl: null,
      provider: null,
      message: 'Manual verification required.',
      challengeResult: parsed.challengeResult,
    };
  }

  const opaqueToken = extractOpaqueToken(pageUrl);

  // 2. Check meta refresh
  if (parsed.metaRefresh) {
    const matchedProvider = providerRegistry.findProvider(parsed.metaRefresh);
    if (matchedProvider) {
      logger.discovered(`Discovered provider destination via meta-refresh: ${parsed.metaRefresh} (${matchedProvider.name})`);
      return {
        status: 'DISCOVERED',
        destinationUrl: parsed.metaRefresh,
        provider: matchedProvider.name,
        sourceToken: opaqueToken,
        method: 'meta_refresh',
      };
    }
  }

  // 3. Check canonical URL if it points to a known provider
  if (parsed.canonicalUrl) {
    const matchedProvider = providerRegistry.findProvider(parsed.canonicalUrl);
    if (matchedProvider) {
      logger.discovered(`Discovered provider destination via canonical URL: ${parsed.canonicalUrl} (${matchedProvider.name})`);
      return {
        status: 'DISCOVERED',
        destinationUrl: parsed.canonicalUrl,
        provider: matchedProvider.name,
        sourceToken: opaqueToken,
        method: 'canonical',
      };
    }
  }

  // 4. Check hyperlinks (<a href>)
  for (const link of parsed.links) {
    const matchedProvider = providerRegistry.findProvider(link.href);
    if (matchedProvider) {
      logger.discovered(`Discovered provider destination via hyperlink: ${link.href} (${matchedProvider.name})`);
      return {
        status: 'DISCOVERED',
        destinationUrl: link.href,
        provider: matchedProvider.name,
        sourceToken: opaqueToken,
        buttonText: link.text,
        method: 'hyperlink',
      };
    }
  }

  // 5. Check form actions
  for (const form of parsed.forms) {
    const matchedProvider = providerRegistry.findProvider(form.action);
    if (matchedProvider) {
      logger.discovered(`Discovered provider destination via form action: ${form.action} (${matchedProvider.name})`);
      return {
        status: 'DISCOVERED',
        destinationUrl: form.action,
        provider: matchedProvider.name,
        sourceToken: opaqueToken,
        method: 'form_action',
      };
    }
  }

  // 6. Check embedded JSON / JSON-LD for exposed provider URLs
  for (const jsonObj of parsed.jsonObjects) {
    const jsonStr = JSON.stringify(jsonObj);
    for (const provider of providerRegistry.listProviders()) {
      if (Array.isArray(provider.domains)) {
        for (const domain of provider.domains) {
          const regex = new RegExp(`https?://[a-zA-Z0-9.-]*${domain}[^"'\s]+`, 'i');
          const match = jsonStr.match(regex);
          if (match) {
            const foundUrl = match[0];
            logger.discovered(`Discovered provider destination via embedded JSON: ${foundUrl} (${provider.name})`);
            return {
              status: 'DISCOVERED',
              destinationUrl: foundUrl,
              provider: provider.name,
              sourceToken: opaqueToken,
              method: 'embedded_json',
            };
          }
        }
      }
    }
  }

  // No exposed destination discovered through normal page inspection
  logger.discovered(`No publicly exposed destination found on intermediate page: ${pageUrl}`);
  return {
    status: 'UNRESOLVED',
    destinationUrl: null,
    provider: null,
    sourceToken: opaqueToken,
    sourceUrl: pageUrl,
  };
}

export default {
  extractOpaqueToken,
  discoverExposedDestination,
};
