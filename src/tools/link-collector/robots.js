import { logger } from '../../logging/logger.js';

/**
 * Lightweight, compliant robots.txt checker with origin-level caching.
 */
export class RobotsChecker {
  /**
   * @param {object} [options]
   * @param {string} [options.userAgent] User-Agent string to check against.
   * @param {number} [options.timeoutMs] Request timeout for fetching robots.txt.
   */
  constructor(options = {}) {
    this.userAgent = options.userAgent || 'LinkCollectorBot/1.0';
    this.timeoutMs = options.timeoutMs || 5000;
    /** @type {Map<string, { rules: Array<{type: string, path: string}>, crawlDelay: number, fetchedAt: number }>} */
    this.cache = new Map();
  }

  /**
   * Checks whether a given URL is allowed to be fetched according to robots.txt.
   *
   * @param {string} urlStr Full URL to evaluate.
   * @returns {Promise<{ allowed: boolean, crawlDelay: number, reason?: string }>}
   */
  async isAllowed(urlStr) {
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch {
      return { allowed: false, crawlDelay: 0, reason: 'Invalid URL' };
    }

    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      return { allowed: false, crawlDelay: 0, reason: 'Non-HTTP protocol' };
    }

    const origin = urlObj.origin;
    let entry = this.cache.get(origin);

    if (!entry) {
      entry = await this._fetchAndParse(origin);
      this.cache.set(origin, entry);
    }

    const path = urlObj.pathname + urlObj.search;

    // Check specific allow/disallow rules in order (most specific match wins)
    let matchedRule = null;
    let maxMatchLen = -1;

    for (const rule of entry.rules) {
      if (this._pathMatches(path, rule.path)) {
        if (rule.path.length > maxMatchLen) {
          maxMatchLen = rule.path.length;
          matchedRule = rule;
        }
      }
    }

    if (matchedRule && matchedRule.type === 'disallow') {
      return {
        allowed: false,
        crawlDelay: entry.crawlDelay,
        reason: `Disallowed by rule: Disallow ${matchedRule.path}`,
      };
    }

    return {
      allowed: true,
      crawlDelay: entry.crawlDelay,
    };
  }

  /**
   * Fetches and parses robots.txt for a given origin.
   * @private
   */
  async _fetchAndParse(origin) {
    const robotsUrl = `${origin}/robots.txt`;
    const rules = [];
    let crawlDelay = 0;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(robotsUrl, {
        headers: { 'User-Agent': this.userAgent },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (res.ok) {
        const text = await res.text();
        const parsed = this._parseRobotsText(text);
        return {
          rules: parsed.rules,
          crawlDelay: parsed.crawlDelay,
          fetchedAt: Date.now(),
        };
      }
    } catch (err) {
      // If robots.txt cannot be reached or 404s, assume no disallow restrictions by convention
      logger.warning?.(`[RobotsChecker] Could not fetch ${robotsUrl}: ${err.message}. Proceeding politely.`);
    }

    return { rules: [], crawlDelay: 0, fetchedAt: Date.now() };
  }

  /**
   * Parses robots.txt file text for applicable user agent blocks.
   * @private
   */
  _parseRobotsText(text) {
    const lines = text.split(/\r?\n/);
    const rules = [];
    let crawlDelay = 0;

    let appliesToUs = false;
    const botTokens = ['*', 'linkcollectorbot', 'bot'];

    for (let rawLine of lines) {
      // Strip comments
      const hashIdx = rawLine.indexOf('#');
      if (hashIdx !== -1) {
        rawLine = rawLine.slice(0, hashIdx);
      }
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const directive = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();

      if (directive === 'user-agent') {
        const valLower = value.toLowerCase();
        appliesToUs = botTokens.some((tok) => valLower.includes(tok));
      } else if (appliesToUs) {
        if (directive === 'disallow' && value) {
          rules.push({ type: 'disallow', path: value });
        } else if (directive === 'allow' && value) {
          rules.push({ type: 'allow', path: value });
        } else if (directive === 'crawl-delay') {
          const parsedDelay = parseFloat(value);
          if (!isNaN(parsedDelay) && parsedDelay > 0) {
            crawlDelay = Math.max(crawlDelay, parsedDelay);
          }
        }
      }
    }

    return { rules, crawlDelay };
  }

  /**
   * Simple prefix and wildcard pattern matching.
   * @private
   */
  _pathMatches(targetPath, rulePath) {
    if (!rulePath || rulePath === '/') return true;
    if (rulePath.endsWith('$')) {
      const cleanRule = rulePath.slice(0, -1);
      return targetPath === cleanRule;
    }
    // Prefix match
    return targetPath.startsWith(rulePath);
  }
}
