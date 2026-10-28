/**
 * Telegram command router and URL recognizer for the 4KHub4U bot.
 * Strictly adheres to Section 2, Section 3, Section 18, and Section 31 of the specification.
 */

import { is4KHub4UUrl } from '../../scrapers/4khub4u/types.js';
import { isHubCloudDriveUrl } from '../../providers/hubcloud/validator.js';
import {
  formatStartMessage,
  formatHelpMessage,
  formatStatusMessage,
  formatInvalidUrlMessage,
} from './messages.js';
import { telegramJobManager } from './handlers.js';

/**
 * Routes an incoming Telegram message to the appropriate command or resolution handler.
 *
 * @param {object} sender Telegram delivery interface
 * @param {object} message Received Telegram message
 * @param {number} message.chatId
 * @param {number} message.userId
 * @param {string} message.text
 * @param {object} [jobManager] In-memory job manager instance
 * @param {object} [resolverOptions] Optional resolution options passed to the underlying resolver
 */
export async function routeIncomingMessage(
  sender,
  message,
  jobManager = telegramJobManager,
  resolverOptions = {}
) {
  const { chatId, userId, text } = message;
  const trimmed = (text || '').trim();

  // 1. /start
  if (trimmed === '/start' || trimmed.startsWith('/start ')) {
    return await sender.sendMessage(chatId, formatStartMessage(), { parse_mode: 'Markdown' });
  }

  // 2. /help
  if (trimmed === '/help' || trimmed.startsWith('/help ')) {
    return await sender.sendMessage(chatId, formatHelpMessage(), { parse_mode: 'Markdown' });
  }

  // 3. /status
  if (trimmed === '/status') {
    const stats = jobManager.getStats();
    return await sender.sendMessage(chatId, formatStatusMessage(stats), { parse_mode: 'Markdown' });
  }

  // 4. /resolve <4KHub4U URL>
  if (trimmed.startsWith('/resolve')) {
    const targetUrl = trimmed.replace(/^\/resolve\s*/i, '').trim();

    if (!targetUrl) {
      return await sender.sendMessage(
        chatId,
        '⚠️ Please specify a URL to resolve.\n\nExample:\n`/resolve https://4khdhub.one/movie-title-1234/`',
        { parse_mode: 'Markdown' }
      );
    }

    return await jobManager.handleIncomingUrl(
      sender,
      { chatId, userId, sourceUrl: targetUrl },
      resolverOptions
    );
  }

  // 5. /search <title>
  if (trimmed.startsWith('/search')) {
    const query = trimmed.replace(/^\/search\s*/i, '').trim();
    if (!query) {
      return await sender.sendMessage(
        chatId,
        '⚠️ Please specify a movie or series title to search.\n\nExample:\n`/search Inception` or `/search Breaking Bad`',
        { parse_mode: 'Markdown' }
      );
    }
    return await jobManager.handleTitleSearch(
      sender,
      { chatId, userId, query },
      resolverOptions
    );
  }

  // 6. Direct URL message recognition (Section 31: allow user to simply send https://4khdhub.example/...)
  if (/^https?:\/\//i.test(trimmed)) {
    const isSupported =
      is4KHub4UUrl(trimmed) ||
      isHubCloudDriveUrl(trimmed) ||
      /greenmotors|fast-share|fastdl|mediator|\?id=|cloudmoviez|unityhub/i.test(trimmed);

    if (isSupported) {
      return await jobManager.handleIncomingUrl(
        sender,
        { chatId, userId, sourceUrl: trimmed },
        resolverOptions
      );
    } else {
      // Reject non-4KHub4U arbitrary URLs
      return await sender.sendMessage(chatId, formatInvalidUrlMessage(), { parse_mode: 'Markdown' });
    }
  }

  // 7. Direct title message recognition (e.g. user sends "Inception", "Breaking Bad", etc.)
  if (trimmed.length >= 2 && !trimmed.startsWith('/')) {
    return await jobManager.handleTitleSearch(
      sender,
      { chatId, userId, query: trimmed },
      resolverOptions
    );
  }

  // 8. Unknown text fallback
  return await sender.sendMessage(
    chatId,
    '❓ Unrecognized command. Send a movie/series title, a 4KHDHub URL, or type `/help` for available commands.',
    { parse_mode: 'Markdown' }
  );
}

export default {
  routeIncomingMessage,
};
