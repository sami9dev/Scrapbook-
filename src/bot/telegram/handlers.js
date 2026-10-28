/**
 * Telegram request handlers and in-memory job isolation manager for 4KHub4U.
 * Strictly adheres to Sections 2, 4, 10, 11, 12, 14, 15, 16, 17, 18, 20, 21, and 23.
 */

import { randomUUID } from 'node:crypto';
import { resolve4KHub4U } from '../../scrapers/4khub4u/resolver.js';
import { parse4KHubCatalogue, resolveCatalogueLinks } from '../../scrapers/4khub4u/catalogue.js';
import { is4KHub4UUrl, Hub4UState } from '../../scrapers/4khub4u/types.js';
import { isHubCloudDriveUrl } from '../../providers/hubcloud/validator.js';
import { fetchWithControls } from '../../discovery/http-client.js';
import { detectHumanVerificationChallenge } from '../../parsing/html-parser.js';
import {
  formatProcessingMessage,
  formatDuplicateJobMessage,
  formatInvalidUrlMessage,
  formatResolutionResult,
  formatCatalogueTelegramSummary,
  formatVerificationRequiredMessage,
  formatErrorMessage,
  splitTelegramMessage,
  escapeHtml,
} from './messages.js';
import { logger } from '../../logging/logger.js';

/**
 * In-memory job manager ensuring user isolation and deduplication.
 */
export class TelegramJobManager {
  constructor() {
    this.startTime = Date.now();
    this.activeJobs = new Map();
    this.completedStats = {
      total: 0,
      successful: 0,
      catalogueCount: 0,
      verification: 0,
      timeout: 0,
      error: 0,
      totalResolverDurationMs: 0,
      totalTelegramOverheadMs: 0,
    };
  }

  getDedupeKey(chatId, url) {
    return `${chatId}::${url.trim().toLowerCase()}`;
  }

  isJobActive(chatId, url) {
    return this.activeJobs.has(this.getDedupeKey(chatId, url));
  }

  getActiveCount() {
    return this.activeJobs.size;
  }

  getStats() {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const avgResolverDurationMs =
      this.completedStats.total > 0
        ? Math.round(this.completedStats.totalResolverDurationMs / this.completedStats.total)
        : 0;
    const avgTelegramOverheadMs =
      this.completedStats.total > 0
        ? Math.round(this.completedStats.totalTelegramOverheadMs / this.completedStats.total)
        : 0;

    return {
      uptimeSeconds,
      activeJobs: this.activeJobs.size,
      completedJobs: this.completedStats.total,
      successfulJobs: this.completedStats.successful,
      catalogueJobs: this.completedStats.catalogueCount,
      verificationRequiredCount: this.completedStats.verification,
      timeoutCount: this.completedStats.timeout,
      errorCount: this.completedStats.error,
      avgResolverDurationMs,
      avgTelegramOverheadMs,
    };
  }

  /**
   * Routes an incoming URL to either Catalogue Generation or On-Demand Link Resolution.
   *
   * @param {object} sender
   * @param {object} params
   * @param {object} [options]
   */
  async handleIncomingUrl(sender, params, options = {}) {
    const trimmedUrl = (params.sourceUrl || '').trim();

    // Direct mediator links or direct HubCloud destinations use on-demand resolution
    const isDirectMediator =
      /greenmotors|fast-share|fastdl|mediator|\?id=/i.test(trimmedUrl) ||
      isHubCloudDriveUrl(trimmedUrl);

    if (isDirectMediator || options.directResolve) {
      return await this.handleResolutionRequest(sender, params, options);
    }

    // UNiTYhub source URL support
    if (/unityhub/i.test(trimmedUrl)) {
      return await this.handleUnityHubRequest(sender, params, options);
    }

    // CloudMoviez source URL support
    if (/cloudmoviez/i.test(trimmedUrl)) {
      return await this.handleCloudMoviezRequest(sender, params, options);
    }

    // Standard 4KHub4U page -> Full Catalogue & Telegraph Presentation
    return await this.handleCatalogueRequest(sender, params, options);
  }

  /**
   * Handles a full catalogue request: fetches page, parses all qualities & seasons,
   * generates a Telegraph page, and delivers a concise summary to Telegram (Section 18).
   *
   * @param {object} sender
   * @param {object} params
   * @param {object} [options]
   */
  async handleCatalogueRequest(sender, params, options = {}) {
    const requestReceivedAt = Date.now();
    const { chatId, userId, sourceUrl } = params;
    const trimmedUrl = (sourceUrl || '').trim();

    // 1. Hostname validation
    if (!is4KHub4UUrl(trimmedUrl)) {
      await sender.sendMessage(chatId, formatInvalidUrlMessage(), { parse_mode: 'Markdown' });
      return { success: false, error: 'Invalid URL' };
    }

    // 2. Duplicate active request check
    const dedupeKey = this.getDedupeKey(chatId, trimmedUrl);
    if (this.activeJobs.has(dedupeKey)) {
      await sender.sendMessage(chatId, formatDuplicateJobMessage());
      return { success: false, error: 'Duplicate request in progress' };
    }

    // 3. Register active job
    const jobId = randomUUID();
    this.activeJobs.set(dedupeKey, { jobId, chatId, userId, sourceUrl: trimmedUrl, createdAt: requestReceivedAt });
    logger.log('4KHub4U', `[4KHub4U] [Job ${jobId}] Catalogue request started: ${trimmedUrl}`);

    let initialMessageId = null;
    try {
      // 4. Initial user feedback (Section 32)
      try {
        const sent = await sender.sendMessage(chatId, formatProcessingMessage('general'));
        initialMessageId = sent?.messageId ?? null;
      } catch (sendErr) {
        logger.warning(`Failed to send initial feedback: ${sendErr.message}`);
      }

      // 5. Fetch source page HTML via HTTP
      const isLocal = trimmedUrl.includes('127.0.0.1') || trimmedUrl.includes('localhost');
      let html = '';
      let finalUrl = trimmedUrl;

      try {
        const fetchRes = await fetchWithControls(trimmedUrl, {
          allowInternal: isLocal,
          maxRetries: isLocal ? 0 : 2,
        });

        if (fetchRes.verificationRequired) {
          await this._deliverFinalMessage(sender, chatId, initialMessageId, formatVerificationRequiredMessage());
          this.completedStats.total++;
          this.completedStats.verification++;
          return { success: false, state: 'VERIFICATION_REQUIRED' };
        }

        if (fetchRes.success && fetchRes.body) {
          html = fetchRes.body;
          finalUrl = fetchRes.finalUrl || trimmedUrl;
        } else {
          const direct = await fetch(trimmedUrl);
          html = await direct.text();
          finalUrl = direct.url || trimmedUrl;
        }
      } catch (fetchErr) {
        const direct = await fetch(trimmedUrl);
        html = await direct.text();
        finalUrl = direct.url || trimmedUrl;
      }

      // Check for human verification challenge on HTML (Section 23)
      const challengeCheck = detectHumanVerificationChallenge(html, finalUrl);
      if (challengeCheck.isChallenge) {
        logger.log('4KHub4U', `[4KHub4U] Human verification challenge detected on ${trimmedUrl}`);
        await this._deliverFinalMessage(sender, chatId, initialMessageId, formatVerificationRequiredMessage());
        this.completedStats.total++;
        this.completedStats.verification++;
        return { success: false, state: 'VERIFICATION_REQUIRED' };
      }

      // 6. Parse complete catalogue
      const parseStart = Date.now();
      const catalogue = parse4KHubCatalogue(html, finalUrl);
      const parseMs = Date.now() - parseStart;

      // 6.5. Automatically resolve mediator links directly to HubCloud / HubDrive destinations
      await resolveCatalogueLinks(catalogue);

      // 7. Direct Telegram message delivery (No Telegraph)
      const messageText = formatCatalogueTelegramSummary(catalogue);

      const sendOptions = {
        disable_web_page_preview: true,
      };

      const tgSendStart = Date.now();
      await this._deliverFinalMessage(sender, chatId, initialMessageId, messageText, sendOptions);
      const tgSendMs = Date.now() - tgSendStart;

      const totalMs = Date.now() - requestReceivedAt;
      this.completedStats.total++;
      this.completedStats.successful++;
      this.completedStats.catalogueCount++;
      this.completedStats.totalResolverDurationMs += parseMs;
      this.completedStats.totalTelegramOverheadMs += tgSendMs;

      logger.log(
        '4KHub4U',
        `[4KHub4U] [Job ${jobId}] Completed catalogue in ${totalMs}ms (Parse: ${parseMs}ms, TG: ${tgSendMs}ms)`
      );

      return {
        success: true,
        catalogue,
        metrics: {
          requestReceivedAt,
          parseMs,
          tgSendMs,
          totalDurationMs: totalMs,
        },
      };
    } catch (err) {
      logger.error(`Catalogue job failed: ${err.message}`);
      await this._deliverFinalMessage(sender, chatId, initialMessageId, formatErrorMessage(err.message));
      this.completedStats.total++;
      this.completedStats.error++;
      return { success: false, error: err.message };
    } finally {
      this.activeJobs.delete(dedupeKey);
    }
  }

  /**
   * Handles on-demand resolution of a specific mediator link (Sections 20, 21, 22).
   */
  async handleResolutionRequest(sender, params, resolverOptions = {}) {
    const requestReceivedAt = Date.now();
    const { chatId, userId, sourceUrl } = params;
    const trimmedUrl = (sourceUrl || '').trim();

    if (!is4KHub4UUrl(trimmedUrl) && !isHubCloudDriveUrl(trimmedUrl)) {
      await sender.sendMessage(chatId, formatInvalidUrlMessage(), { parse_mode: 'Markdown' });
      return { success: false, state: 'ERROR', error: 'Invalid URL' };
    }

    const dedupeKey = this.getDedupeKey(chatId, trimmedUrl);
    if (this.activeJobs.has(dedupeKey)) {
      await sender.sendMessage(chatId, formatDuplicateJobMessage());
      return { success: false, state: 'ERROR', error: 'Job already in progress' };
    }

    const jobId = randomUUID();
    this.activeJobs.set(dedupeKey, { jobId, chatId, userId, sourceUrl: trimmedUrl, createdAt: requestReceivedAt });
    logger.log('TELEGRAM_JOB', `[Job ${jobId}] Started for user ${userId} in chat ${chatId}: ${trimmedUrl}`);

    let initialMessageId = null;
    try {
      try {
        const sent = await sender.sendMessage(chatId, formatProcessingMessage('resolve'));
        initialMessageId = sent?.messageId ?? null;
      } catch (sendErr) {
        logger.warning(`Failed to send initial processing message: ${sendErr.message}`);
      }

      // Execute HTTP-first resolver
      const resolution = await resolve4KHub4U(trimmedUrl, {
        requestReceivedAt,
        useHttpFirst: true,
        ...resolverOptions,
      });

      const telegramResponseStartedAt = Date.now();
      const messageText = formatResolutionResult(resolution);

      const sendOptions = {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        reply_markup: resolution.destination
          ? {
              inline_keyboard: [[{ text: '🚀 Open HubCloud', url: resolution.destination }]],
            }
          : undefined,
      };

      await this._deliverFinalMessage(sender, chatId, initialMessageId, messageText, sendOptions);
      const telegramResponseFinishedAt = Date.now();

      resolution.metrics.telegramResponseStartedAt = telegramResponseStartedAt;
      resolution.metrics.telegramResponseFinishedAt = telegramResponseFinishedAt;
      resolution.metrics.telegramOverheadMs =
        telegramResponseFinishedAt - resolution.metrics.resolverFinishedAt;
      resolution.metrics.totalDurationMs = telegramResponseFinishedAt - requestReceivedAt;

      this.completedStats.total++;
      this.completedStats.totalResolverDurationMs += resolution.metrics.resolverDurationMs;
      this.completedStats.totalTelegramOverheadMs += resolution.metrics.telegramOverheadMs;

      if (resolution.success) {
        this.completedStats.successful++;
      } else if (resolution.state === 'VERIFICATION_REQUIRED') {
        this.completedStats.verification++;
      } else if (resolution.state === 'TIMEOUT') {
        this.completedStats.timeout++;
      } else {
        this.completedStats.error++;
      }

      logger.log(
        'TELEGRAM_JOB',
        `[Job ${jobId}] Completed in ${resolution.metrics.totalDurationMs}ms (Resolver: ${resolution.metrics.resolverDurationMs}ms, TG: ${resolution.metrics.telegramOverheadMs}ms)`
      );

      return resolution;
    } finally {
      this.activeJobs.delete(dedupeKey);
    }
  }

  /**
   * Handles CloudMoviez source URL: parses page, decodes ?file= destinations,
   * generates Telegraph presentation page, and delivers formatted message to Telegram.
   */
  async handleCloudMoviezRequest(sender, params, options = {}) {
    const requestReceivedAt = Date.now();
    const { chatId, userId, sourceUrl } = params;
    const trimmedUrl = (sourceUrl || '').trim();

    const dedupeKey = this.getDedupeKey(chatId, trimmedUrl);
    if (this.activeJobs.has(dedupeKey)) {
      await sender.sendMessage(chatId, formatDuplicateJobMessage());
      return { success: false, error: 'Duplicate request in progress' };
    }

    const jobId = randomUUID();
    this.activeJobs.set(dedupeKey, { jobId, chatId, userId, sourceUrl: trimmedUrl, createdAt: requestReceivedAt });
    logger.log('CloudMoviez', `[CloudMoviez] [Job ${jobId}] Request started: ${trimmedUrl}`);

    let initialMessageId = null;
    try {
      try {
        const sent = await sender.sendMessage(chatId, formatProcessingMessage('general'));
        initialMessageId = sent?.messageId ?? null;
      } catch (sendErr) {
        logger.warning(`Failed to send initial feedback: ${sendErr.message}`);
      }

      const fetchRes = await fetchWithControls(trimmedUrl);
      if (!fetchRes.success || !fetchRes.body) {
        throw new Error(fetchRes.error || 'Failed to fetch CloudMoviez page');
      }

      const { parseSourcePage } = await import('../../sources/source-parser.js');

      const sourceData = parseSourcePage(fetchRes.body, fetchRes.finalUrl || trimmedUrl);
      const links = sourceData.discoveredLinks || [];

      // Unpack direct base64 ?file= links
      const resolvedList = [];
      for (const item of links) {
        let destUrl = item.resolvedUrl;
        const fileMatch = destUrl.match(/[?&]file=([a-zA-Z0-9+/=]+)/);
        if (fileMatch) {
          try {
            const raw = Buffer.from(fileMatch[1], 'base64').toString('utf8');
            const p = JSON.parse(raw);
            if (p.url) destUrl = p.url;
          } catch {}
        }
        // Exclude DotFlix / dtflix links so only genuine GDFLIX links are saved
        if (/dtflix|dotflix/i.test(destUrl)) {
          continue;
        }
        resolvedList.push({
          ...item,
          destUrl,
        });
      }

      const qualities = [...new Set(resolvedList.map((l) => l.quality).filter(Boolean))];
      const summaryLines = [
        `🎬 <b>${escapeHtml(sourceData.title)}${sourceData.year ? ` (${sourceData.year})` : ''}</b>`,
        '',
        `📺 <b>${resolvedList.length} Download Links Available</b>`,
        qualities.length > 0 ? `🎞 <b>${escapeHtml(qualities.join(' + '))}</b>` : '',
        '',
        '📥 <b>Direct Download Links:</b>',
      ];

      for (const item of resolvedList) {
        const label = item.filename || item.rowTitle || sourceData.title;
        const sizeBadge = item.sizeDisplay ? ` (${escapeHtml(item.sizeDisplay)})` : '';
        const provStr = (item.provider || 'GDFLIX').toUpperCase();
        summaryLines.push('');
        summaryLines.push(`• <b>${escapeHtml(label)}</b>${sizeBadge} [${provStr}]`);
        summaryLines.push(`  🔗 <a href="${item.destUrl}">${item.destUrl}</a>`);
      }

      const messageText = summaryLines.join('\n');
      const sendOptions = {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      };

      await this._deliverFinalMessage(sender, chatId, initialMessageId, messageText, sendOptions);
      this.completedStats.total++;
      this.completedStats.successful++;
      this.completedStats.catalogueCount++;
      return { success: true, count: resolvedList.length };
    } catch (err) {
      logger.error(`CloudMoviez request error: ${err.message}`);
      await this._deliverFinalMessage(sender, chatId, initialMessageId, formatErrorMessage(err.message));
      this.completedStats.total++;
      this.completedStats.error++;
      return { success: false, error: err.message };
    } finally {
      this.activeJobs.delete(dedupeKey);
    }
  }

  /**
   * Handles UNiTYhub source URL: fetches releases from API,
   * and delivers direct HubCloud / GDFLIX links to Telegram.
   */
  async handleUnityHubRequest(sender, params, options = {}) {
    const requestReceivedAt = Date.now();
    const { chatId, userId, sourceUrl } = params;
    const trimmedUrl = (sourceUrl || '').trim();

    const dedupeKey = this.getDedupeKey(chatId, trimmedUrl);
    if (this.activeJobs.has(dedupeKey)) {
      await sender.sendMessage(chatId, formatDuplicateJobMessage());
      return { success: false, error: 'Duplicate request in progress' };
    }

    const jobId = randomUUID();
    this.activeJobs.set(dedupeKey, { jobId, chatId, userId, sourceUrl: trimmedUrl, createdAt: requestReceivedAt });
    logger.log('UNiTYhub', `[UNiTYhub] [Job ${jobId}] Request started: ${trimmedUrl}`);

    let initialMessageId = null;
    try {
      try {
        const sent = await sender.sendMessage(chatId, formatProcessingMessage('general'));
        initialMessageId = sent?.messageId ?? null;
      } catch (sendErr) {
        logger.warning(`Failed to send initial feedback: ${sendErr.message}`);
      }

      const { extractUnityHubLinks } = await import('../../providers/unityhub/extractor.js');
      const data = await extractUnityHubLinks('', trimmedUrl);
      const links = data.allLinks || data.links || [];

      const lines = [
        `🎬 <b>${escapeHtml(data.title || 'UNiTYhub Release')}</b>`,
        data.audios && data.audios.length > 0 ? `🔊 <b>${escapeHtml(data.audios.join(' + '))}</b>` : '',
        '',
        `📥 <b>Direct Download Links (${links.length}):</b>`,
      ];

      for (const item of links) {
        const label = item.filename || item.title;
        const sizeBadge = item.sizeDisplay ? ` (${escapeHtml(item.sizeDisplay)})` : '';
        const provStr = (item.provider || 'UNKNOWN').toUpperCase();
        lines.push('');
        lines.push(`• <b>${escapeHtml(label)}</b>${sizeBadge} [${provStr}]`);
        lines.push(`  🔗 <a href="${item.providerUrl}">${item.providerUrl}</a>`);
      }

      const messageText = lines.filter(Boolean).join('\n');
      const sendOptions = {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      };

      await this._deliverFinalMessage(sender, chatId, initialMessageId, messageText, sendOptions);
      this.completedStats.total++;
      this.completedStats.successful++;
      this.completedStats.catalogueCount++;
      return { success: true, count: links.length };
    } catch (err) {
      logger.error(`UNiTYhub request error: ${err.message}`);
      await this._deliverFinalMessage(sender, chatId, initialMessageId, formatErrorMessage(err.message));
      this.completedStats.total++;
      this.completedStats.error++;
      return { success: false, error: err.message };
    } finally {
      this.activeJobs.delete(dedupeKey);
    }
  }

  /**
   * Handles a direct title search request: searches 4KHDHub, selects best match,
   * and automatically initiates catalogue scraping & link resolution.
   *
   * @param {object} sender
   * @param {object} params
   * @param {number} params.chatId
   * @param {number} params.userId
   * @param {string} params.query
   * @param {object} [options]
   */
  async handleTitleSearch(sender, params, options = {}) {
    const { chatId, userId, query } = params;
    const trimmed = (query || '').trim();

    if (!trimmed) {
      await sender.sendMessage(
        chatId,
        '⚠️ Please provide a movie or series title to search.\n\nExample: `Inception` or `/search Breaking Bad`',
        { parse_mode: 'Markdown' }
      );
      return { success: false, error: 'Empty query' };
    }

    let searchMsgId = null;
    try {
      const sent = await sender.sendMessage(
        chatId,
        `🔍 Searching 4KHDHub for "<b>${escapeHtml(trimmed)}</b>"...`,
        { parse_mode: 'HTML' }
      );
      searchMsgId = sent?.messageId ?? null;
    } catch (err) {
      logger.warning(`Failed sending search status message: ${err.message}`);
    }

    try {
      const { search4KHDHub } = await import('../../providers/4khdhub/search.js');
      const searchResult = await search4KHDHub(trimmed);

      if (!searchResult.success || !searchResult.bestMatch) {
        const notFoundText = `❌ No results found on 4KHDHub for "<b>${escapeHtml(trimmed)}</b>".\n\nPlease check the spelling or send a direct URL.`;
        if (searchMsgId && sender.editMessageText) {
          try {
            await sender.editMessageText(chatId, searchMsgId, notFoundText, { parse_mode: 'HTML' });
            return { success: false, error: 'Not found' };
          } catch {}
        }
        await sender.sendMessage(chatId, notFoundText, { parse_mode: 'HTML' });
        return { success: false, error: 'Not found' };
      }

      const match = searchResult.bestMatch;
      const foundText = `🎬 Found: <b>${escapeHtml(match.title)}</b>\n⏳ Extracting and resolving links...`;
      if (searchMsgId && sender.editMessageText) {
        try {
          await sender.editMessageText(chatId, searchMsgId, foundText, { parse_mode: 'HTML' });
        } catch {}
      }

      // Automatically hand off to handleCatalogueRequest with the matched URL
      return await this.handleCatalogueRequest(
        sender,
        { chatId, userId, sourceUrl: match.url },
        options
      );
    } catch (err) {
      logger.error(`Title search failed for "${trimmed}": ${err.message}`);
      await sender.sendMessage(chatId, formatErrorMessage(`Search failed: ${err.message}`));
      return { success: false, error: err.message };
    }
  }

  async _deliverFinalMessage(sender, chatId, initialMessageId, textOrChunks, options = {}) {
    const chunks = Array.isArray(textOrChunks) ? textOrChunks : splitTelegramMessage(textOrChunks);
    if (chunks.length === 0) return;

    try {
      if (initialMessageId !== null && sender.editMessageText) {
        await sender.editMessageText(chatId, initialMessageId, chunks[0], options);
      } else {
        await sender.sendMessage(chatId, chunks[0], options);
      }

      for (let i = 1; i < chunks.length; i++) {
        await sender.sendMessage(chatId, chunks[i], options);
      }
    } catch {
      try {
        for (const chunk of chunks) {
          await sender.sendMessage(chatId, chunk, options);
        }
      } catch (e) {
        logger.error(`Failed to deliver final Telegram message: ${e.message}`);
      }
    }
  }
}

export const telegramJobManager = new TelegramJobManager();
export default {
  TelegramJobManager,
  telegramJobManager,
};
