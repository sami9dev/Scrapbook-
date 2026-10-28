import fs from 'node:fs';
import path from 'node:path';
import { extractPageLinks } from './extractor.js';
import { LinkResolver } from './resolver.js';
import { RobotsChecker } from './robots.js';
import { logger } from '../../logging/logger.js';

/**
 * Delays execution for specified milliseconds.
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Escapes a string value for safe insertion into RFC 4180 CSV format.
 *
 * @param {string|number|null|undefined} val
 * @returns {string}
 */
export function escapeCsvField(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return `"${str}"`;
}

/**
 * Converts an array of resolved link records into CSV format.
 *
 * @param {Array<object>} records
 * @returns {string}
 */
export function formatRecordsToCsv(records) {
  const headers = [
    'Original URL',
    'Final URL',
    'HTTP Status',
    'Page Title',
    'Redirect Count',
    'Source Page',
    'Error / Status Note',
  ];

  const rows = records.map((r) => [
    escapeCsvField(r.originalUrl),
    escapeCsvField(r.finalUrl),
    escapeCsvField(r.httpStatus || ''),
    escapeCsvField(r.pageTitle || ''),
    escapeCsvField(r.redirectCount ?? 0),
    escapeCsvField(r.sourceUrl || ''),
    escapeCsvField(r.error || ''),
  ].join(','));

  return [headers.join(','), ...rows].join('\r\n');
}

/**
 * Orchestrates extracting links from starting pages, respecting robots.txt,
 * following redirects with rate limiting, and outputting to CSV.
 */
export class LinkCollector {
  /**
   * @param {object} [options]
   * @param {number} [options.concurrency] Max simultaneous resolver requests (default 2).
   * @param {number} [options.delayMs] Polite delay in ms between requests (default 500).
   * @param {number} [options.timeoutMs] Request timeout in ms (default 10000).
   * @param {number} [options.maxRedirects] Maximum redirect hops (default 5).
   * @param {boolean} [options.respectRobotsTxt] Obey robots.txt rules (default true).
   * @param {string} [options.userAgent] User-Agent string.
   * @param {string} [options.outputPath] Output CSV path.
   * @param {(prog: object) => void} [options.onProgress] Progress reporting callback.
   */
  constructor(options = {}) {
    this.concurrency = Math.max(1, options.concurrency || 2);
    this.delayMs = Math.max(0, options.delayMs ?? 500);
    this.timeoutMs = options.timeoutMs || 10000;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.respectRobotsTxt = options.respectRobotsTxt !== false;
    this.userAgent = options.userAgent || 'LinkCollectorBot/1.0 (+https://example.com/bot; legitimate link auditor)';
    this.outputPath = options.outputPath || null;
    this.onProgress = options.onProgress || (() => {});

    this.robotsChecker = new RobotsChecker({
      userAgent: this.userAgent,
      timeoutMs: Math.min(5000, this.timeoutMs),
    });

    this.resolver = new LinkResolver({
      timeoutMs: this.timeoutMs,
      maxRedirects: this.maxRedirects,
      userAgent: this.userAgent,
    });
  }

  /**
   * Runs link extraction and redirect resolution on a list of starting pages.
   *
   * @param {string[]} startUrls Array of starting webpage URLs.
   * @returns {Promise<{
   *   records: Array<object>,
   *   csv: string,
   *   summary: { totalDiscovered: number, resolved: number, errors: number, durationMs: number }
   * }>}
   */
  async run(startUrls) {
    const startTime = Date.now();
    const discoveredLinks = [];
    const seenUrls = new Set();

    logger.discovered?.(`[LinkCollector] Starting crawl for ${startUrls.length} starting URL(s)...`);

    // 1. Fetch each start page and extract links
    for (const startUrl of startUrls) {
      if (this.respectRobotsTxt) {
        const robotsCheck = await this.robotsChecker.isAllowed(startUrl);
        if (!robotsCheck.allowed) {
          logger.warning?.(`[LinkCollector] Skipping start URL disallowed by robots.txt: ${startUrl}`);
          discoveredLinks.push({
            originalUrl: startUrl,
            sourceUrl: 'START_PAGE',
            disallowed: true,
            disallowedReason: robotsCheck.reason,
          });
          continue;
        }
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const res = await fetch(startUrl, {
          headers: { 'User-Agent': this.userAgent },
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        if (!res.ok) {
          logger.warning?.(`[LinkCollector] Failed to fetch starting page ${startUrl}: HTTP ${res.status}`);
          continue;
        }

        const html = await res.text();
        const { links } = extractPageLinks(html, startUrl);
        logger.discovered?.(`[LinkCollector] Extracted ${links.length} link(s) from ${startUrl}`);

        for (const item of links) {
          if (!seenUrls.has(item.url)) {
            seenUrls.add(item.url);
            discoveredLinks.push({
              originalUrl: item.url,
              sourceUrl: startUrl,
              text: item.text,
            });
          }
        }
      } catch (err) {
        logger.error?.(`[LinkCollector] Error loading start page ${startUrl}: ${err.message}`);
      }

      if (this.delayMs > 0) {
        await sleep(this.delayMs);
      }
    }

    const totalToResolve = discoveredLinks.length;
    logger.discovered?.(`[LinkCollector] Total unique link(s) queued for redirect resolution: ${totalToResolve}`);

    const resolvedRecords = [];
    let processedCount = 0;
    let errorCount = 0;

    // 2. Resolve redirect chains with bounded concurrency and rate limiting
    let queueIndex = 0;

    const worker = async () => {
      while (queueIndex < discoveredLinks.length) {
        const item = discoveredLinks[queueIndex++];

        if (item.disallowed) {
          resolvedRecords.push({
            originalUrl: item.originalUrl,
            finalUrl: item.originalUrl,
            httpStatus: 403,
            pageTitle: '',
            redirectCount: 0,
            sourceUrl: item.sourceUrl,
            error: item.disallowedReason || 'Disallowed by robots.txt',
          });
          errorCount++;
          processedCount++;
          this.onProgress({ processed: processedCount, total: totalToResolve, current: item.originalUrl });
          continue;
        }

        // Check robots.txt before visiting destination
        if (this.respectRobotsTxt) {
          const check = await this.robotsChecker.isAllowed(item.originalUrl);
          if (!check.allowed) {
            resolvedRecords.push({
              originalUrl: item.originalUrl,
              finalUrl: item.originalUrl,
              httpStatus: 403,
              pageTitle: '',
              redirectCount: 0,
              sourceUrl: item.sourceUrl,
              error: check.reason || 'Disallowed by robots.txt',
            });
            errorCount++;
            processedCount++;
            this.onProgress({ processed: processedCount, total: totalToResolve, current: item.originalUrl });
            continue;
          }
        }

        // Polite delay
        if (this.delayMs > 0) {
          await sleep(this.delayMs);
        }

        const resolved = await this.resolver.resolve(item.originalUrl);

        resolvedRecords.push({
          ...resolved,
          sourceUrl: item.sourceUrl,
        });

        if (resolved.error) {
          errorCount++;
        }

        processedCount++;
        this.onProgress({
          processed: processedCount,
          total: totalToResolve,
          current: item.originalUrl,
          finalUrl: resolved.finalUrl,
          status: resolved.httpStatus,
        });
      }
    };

    const workers = Array.from({ length: this.concurrency }, () => worker());
    await Promise.all(workers);

    // 3. Format CSV
    const csv = formatRecordsToCsv(resolvedRecords);

    // 4. Save to output path if specified
    if (this.outputPath) {
      const fullPath = path.resolve(this.outputPath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, csv, 'utf8');
      logger.discovered?.(`[LinkCollector] Results saved to CSV file: ${fullPath}`);
    }

    const durationMs = Date.now() - startTime;

    return {
      records: resolvedRecords,
      csv,
      summary: {
        totalDiscovered: totalToResolve,
        resolved: resolvedRecords.length,
        errors: errorCount,
        durationMs,
      },
    };
  }
}
