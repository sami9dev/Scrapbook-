import { parseGeneric } from './generic.js';

/**
 * Provider Registry for managing recognized provider definitions.
 * Providers can be registered dynamically without modifying the core scraper.
 */
export class ProviderRegistry {
  constructor() {
    this.providers = [];
  }

  /**
   * Registers a provider definition.
   * @param {object} provider
   * @param {string} provider.name - Provider name (e.g. 'GDFLIX')
   * @param {string[]} [provider.domains] - Domain names or patterns associated with the provider
   * @param {Function} [provider.matchUrl] - Optional custom URL matcher function
   * @param {Function} provider.parser - Parser function: async (html, url, options) => result
   */
  register(provider) {
    if (!provider || !provider.name || typeof provider.parser !== 'function') {
      throw new Error('Provider must have a valid name and a parser function');
    }

    // Replace if already registered with same name, or append
    const idx = this.providers.findIndex((p) => p.name.toUpperCase() === provider.name.toUpperCase());
    if (idx >= 0) {
      this.providers[idx] = provider;
    } else {
      this.providers.push(provider);
    }
  }

  /**
   * Finds the matching provider for a given URL.
   * @param {string} url
   * @returns {object|null}
   */
  findProvider(url) {
    if (!url || typeof url !== 'string') return null;

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();

    for (const provider of this.providers) {
      // 1. Check custom matcher if provided
      if (typeof provider.matchUrl === 'function' && provider.matchUrl(url, parsed)) {
        return provider;
      }

      // 2. Check domains list
      if (Array.isArray(provider.domains)) {
        const matches = provider.domains.some((d) => {
          const dom = d.toLowerCase();
          return hostname === dom || hostname.endsWith(`.${dom}`);
        });
        if (matches) return provider;
      }
    }

    return null;
  }

  /**
   * Returns all registered providers.
   */
  listProviders() {
    return [...this.providers];
  }

  /**
   * Resets the registry.
   */
  clear() {
    this.providers = [];
  }
}

export const providerRegistry = new ProviderRegistry();
export default providerRegistry;
