/**
 * Telegram Bot Client for 4KHub4U
 *
 * Lightweight, zero-dependency Telegram Bot API client using native fetch.
 * Strictly adheres to Section 1, 9, 14, and 18 of the specification.
 * Supports both Long Polling and Webhook modes.
 */

import { routeIncomingMessage } from './commands.js';
import { telegramJobManager } from './handlers.js';
import { logger } from '../../logging/logger.js';

export class Telegram4KHub4UBot {
  constructor(options = {}) {
    this.token = (options.token || process.env.TELEGRAM_BOT_TOKEN || '').trim();
    this.apiBaseUrl = options.apiBaseUrl || 'https://api.telegram.org';
    this.jobManager = options.jobManager || telegramJobManager;
    this.resolverOptions = { useHttpFirst: true, ...(options.resolverOptions || {}) };
    this.fetchFn = options.fetchFn || globalThis.fetch;

    this.isPollingActive = false;
    this.pollingAbortController = null;
    this.lastUpdateId = 0;
  }

  getToken() {
    return this.token;
  }

  getEndpoint(method) {
    if (!this.token) {
      throw new Error('Telegram bot token is not configured. Set TELEGRAM_BOT_TOKEN in .env');
    }
    return `${this.apiBaseUrl}/bot${this.token}/${method}`;
  }

  /**
   * Sends a message to a Telegram chat.
   */
  async sendMessage(chatId, text, options = {}) {
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: options.parse_mode,
      disable_web_page_preview: options.disable_web_page_preview ?? false,
      reply_markup: options.reply_markup,
    };

    const res = await this.fetchFn(this.getEndpoint('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Telegram sendMessage failed: ${data.description || res.statusText}`);
    }

    return { messageId: data.result?.message_id };
  }

  /**
   * Edits the text of an existing message.
   */
  async editMessageText(chatId, messageId, text, options = {}) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: options.parse_mode,
      disable_web_page_preview: options.disable_web_page_preview ?? false,
      reply_markup: options.reply_markup,
    };

    const res = await this.fetchFn(this.getEndpoint('editMessageText'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Telegram editMessageText failed: ${data.description || res.statusText}`);
    }
  }

  /**
   * Processes a single raw Telegram Update object.
   */
  async handleUpdate(update) {
    if (!update) return null;

    const message = update.message || update.channel_post;
    if (!message || !message.text) {
      return null;
    }

    const incoming = {
      chatId: message.chat?.id,
      userId: message.from?.id || message.chat?.id,
      text: message.text,
    };

    return await routeIncomingMessage(this, incoming, this.jobManager, this.resolverOptions);
  }

  /**
   * Starts long-polling for updates.
   */
  async startPolling(pollIntervalMs = 500) {
    if (this.isPollingActive) {
      logger.warning('Telegram polling is already active.');
      return;
    }

    if (!this.token) {
      logger.warning('TELEGRAM_BOT_TOKEN is not configured. Polling not started.');
      return;
    }

    this.isPollingActive = true;
    this.pollingAbortController = new AbortController();
    logger.log('TELEGRAM_BOT', 'Starting Telegram long polling...');

    // Delete existing webhook if set so polling works smoothly
    try {
      await this.fetchFn(this.getEndpoint('deleteWebhook'), { method: 'POST' });
    } catch {}

    const pollLoop = async () => {
      while (this.isPollingActive) {
        try {
          const endpoint = `${this.getEndpoint('getUpdates')}?offset=${this.lastUpdateId + 1}&timeout=20`;
          const res = await this.fetchFn(endpoint, {
            signal: this.pollingAbortController?.signal,
          });

          if (res.ok) {
            const data = await res.json();
            if (data.ok && Array.isArray(data.result)) {
              for (const update of data.result) {
                if (update.update_id > this.lastUpdateId) {
                  this.lastUpdateId = update.update_id;
                }
                // Process update asynchronously without blocking the polling loop
                this.handleUpdate(update).catch((err) => {
                  logger.error(`Error processing update ${update.update_id}: ${err.message}`);
                });
              }
            }
          }
        } catch (err) {
          if (!this.isPollingActive) break;
          logger.warning(`Telegram polling request error: ${err.message}`);
          await new Promise((r) => setTimeout(r, 2000));
        }

        if (this.isPollingActive && pollIntervalMs > 0) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
        }
      }
    };

    pollLoop().catch((err) => {
      logger.error(`Telegram polling loop exited with error: ${err.message}`);
    });
  }

  /**
   * Stops long polling gracefully.
   */
  stopPolling() {
    this.isPollingActive = false;
    if (this.pollingAbortController) {
      this.pollingAbortController.abort();
      this.pollingAbortController = null;
    }
    logger.log('TELEGRAM_BOT', 'Stopped Telegram long polling.');
  }

  isPolling() {
    return this.isPollingActive;
  }
}

export default {
  Telegram4KHub4UBot,
};
