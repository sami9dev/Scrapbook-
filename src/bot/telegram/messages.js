/**
 * Telegram message formatting utilities for the 4KHub4U bot.
 * Strictly adheres to Sections 18, 23, and 32 of the specification.
 */

export function formatStartMessage() {
  return [
    '👋 *Welcome to the 4KHub4U Catalogue & Resolver Bot*',
    '',
    'Send me any Movie or Series name (e.g. `Inception`, `Breaking Bad`) or 4KHDHub link to get direct download links.',
    '',
    '*Available Commands & Usage:*',
    '• Send any title directly (e.g. `Inception`, `Breaking Bad`)',
    '• `/search <title>` — Search for a movie or TV show',
    '• `/resolve <URL>` — Extract complete catalogue & download links from a URL',
    '• `/status` — View active queue and bot statistics',
    '• `/help` — How to use this bot',
  ].join('\n');
}

export function formatHelpMessage() {
  return [
    '📖 *4KHub4U Bot Help*',
    '',
    'You can send a title directly or paste a 4KHDHub URL into the chat.',
    '',
    '*Examples:*',
    '• Type `Inception` or `Breaking Bad`',
    '• `/search Interstellar`',
    '• `/resolve https://4khdhub.one/inception-movie-509/`',
    '• Or simply paste the URL directly into the chat.',
    '',
    'The bot will extract all available releases, qualities (1080p, 2160p HDR/DV/SDR), and seasons with direct HubCloud drive links.',
    '',
    '_Note: Direct titles search 4KHDHub automatically._',
  ].join('\n');
}

export function formatProcessingMessage(type = 'general') {
  if (type === 'resolve') {
    return '⏳ Processing 4KHub4U URL...\n🔎 Resolving download destination...';
  }
  if (type === 'series') return '🔎 Reading series...';
  return '🔎 Reading available releases...';
}

export function formatDuplicateJobMessage() {
  return '⏳ A resolution job for this URL is already in progress. Please wait for it to complete.';
}

export function formatInvalidUrlMessage() {
  return [
    '❌ *Invalid URL*',
    '',
    'Please provide a valid 4KHub4U / 4KHDHub URL (e.g. `https://4khdhub.one/...`).',
    'Arbitrary URLs are not accepted.',
  ].join('\n');
}

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Formats a concise Telegram summary message presenting the Telegraph catalogue (Section 18).
 *
 * @param {import('../../scrapers/4khub4u/types.js').FourKHubCatalogue} catalogue
 * @param {string} [telegraphUrl]
 * @param {Array<{ url: string, label: string }>} [telegraphPages]
 * @returns {string}
 */
export function formatCatalogueTelegramSummary(catalogue, telegraphUrl = '', telegraphPages = []) {
  const lines = [];

  const titleStr = catalogue.year ? `${catalogue.title} (${catalogue.year})` : catalogue.title;
  lines.push(`🎬 <b>${escapeHtml(titleStr)}</b>`);
  lines.push('');

  if (catalogue.type === 'series') {
    const seasonCount = catalogue.seasons?.length || 0;
    lines.push(`📺 <b>${seasonCount} Season${seasonCount === 1 ? '' : 's'}</b>`);
  }

  // Qualities summary (e.g. 1080p + 2160p)
  if (catalogue.qualities && catalogue.qualities.length > 0) {
    const qNames = catalogue.qualities.map((q) => q.resolution);
    lines.push(`🎞 <b>${escapeHtml(qNames.join(' + '))}</b>`);
  }

  // Audio summary (e.g. Hindi + English)
  if (catalogue.audioLanguages && catalogue.audioLanguages.length > 0) {
    lines.push(`🔊 <b>${escapeHtml(catalogue.audioLanguages.join(' + '))}</b>`);
  }

  // Variants highlight (HDR, DV, SDR, etc.)
  const variantSet = new Set();
  const allReleases =
    catalogue.type === 'series'
      ? catalogue.seasons.flatMap((s) => s.releases)
      : catalogue.qualities.flatMap((q) => q.releases);

  for (const rel of allReleases) {
    if (rel.dynamicRange) variantSet.add(rel.dynamicRange);
    if (rel.sourceType) variantSet.add(rel.sourceType);
    if (rel.codec) variantSet.add(rel.codec);
  }

  const notable = ['Dolby Vision', 'DV', 'HDR', 'SDR', '10-bit', 'REMUX'].filter((v) =>
    Array.from(variantSet).some((x) => x.toLowerCase().includes(v.toLowerCase()))
  );

  if (notable.length > 0) {
    lines.push(`🎥 <b>${notable.join(' / ')} variants available</b>`);
  }

  if (telegraphUrl) {
    lines.push('');
    lines.push('📖 <b>Complete release catalogue:</b>');
    if (Array.isArray(telegraphPages) && telegraphPages.length > 1) {
      for (const page of telegraphPages) {
        lines.push(`• <b>${escapeHtml(page.label)}:</b> <a href="${page.url}">${page.url}</a>`);
      }
    } else {
      lines.push(`<a href="${telegraphUrl}">${telegraphUrl}</a>`);
    }
    return lines.join('\n');
  }

  // Direct Telegram output in the exact format requested:
  // Filename
  // URL
  //
  // Filename
  // URL
  const entries = [];
  for (const rel of allReleases) {
    const validLinks = (rel.downloadLinks || []).filter(
      (l) => l.url && !l.isInvalid && !/hubdrive/i.test(l.provider || '')
    );
    for (const l of validLinks) {
      const name = rel.filename || rel.label || catalogue.title;
      entries.push(`${name}\n${l.url}`);
    }
  }

  return entries.join('\n\n');
}

/**
 * Splits a long Telegram message into multiple chunks if it exceeds maxLen.
 * Ensures chunks do not exceed Telegram's 4096 character limit and keeps pairs intact.
 *
 * @param {string} text
 * @param {number} [maxLen=4000]
 * @returns {string[]}
 */
export function splitTelegramMessage(text, maxLen = 4000) {
  if (!text || text.length <= maxLen) {
    return [text || ''];
  }

  const chunks = [];
  const entries = text.split('\n\n');
  let currentChunk = '';

  for (const entry of entries) {
    if (currentChunk.length + entry.length + 2 > maxLen) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = entry;
    } else {
      currentChunk = currentChunk ? `${currentChunk}\n\n${entry}` : entry;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

export function formatSuccessMessage(resolution) {
  const elapsedSec = (resolution.metrics.resolverDurationMs / 1000).toFixed(2);
  const destination = resolution.destination || '';

  return [
    '✅ 4KHub4U resolved',
    '',
    `Title: ${resolution.title || '4KHub4U Content'}`,
    '',
    `Provider: ${resolution.provider || 'HubCloud'}`,
    '',
    `Resolver time: ${elapsedSec}s`,
    '',
    `Destination:`,
    destination,
  ].join('\n');
}

export function formatDestinationNotExposedMessage() {
  return [
    '⚠️ Destination not exposed',
    '',
    'The resolver could not find a publicly available HubCloud destination.',
  ].join('\n');
}

export function formatVerificationRequiredMessage() {
  return [
    '⚠️ Human verification required',
    '',
    'This release requires human verification.',
    'No verification bypass was attempted.',
  ].join('\n');
}

export function formatTimeoutMessage() {
  return [
    '⏱️ Resolution timed out',
    '',
    'The 4KHub4U resolver exceeded its configured timeout.',
  ].join('\n');
}

export function formatErrorMessage(errorMsg) {
  return [
    '❌ Resolution error',
    '',
    errorMsg || 'An unexpected error occurred while resolving the URL.',
  ].join('\n');
}

export function formatStatusMessage(stats) {
  const avgSec = (stats.avgResolverDurationMs / 1000).toFixed(2);
  const uptimeMins = Math.floor(stats.uptimeSeconds / 60);

  return [
    '📊 *4KHub4U Bot Status*',
    '',
    `• Uptime: ${uptimeMins}m (${stats.uptimeSeconds}s)`,
    `• Active Jobs: ${stats.activeJobs}`,
    `• Completed Jobs: ${stats.completedJobs}`,
    `• Successful: ${stats.successfulJobs}`,
    `• Human Verification Required: ${stats.verificationRequiredCount}`,
    `• Timeouts: ${stats.timeoutCount}`,
    `• Average Resolver Time: ${avgSec}s`,
  ].join('\n');
}

export function formatResolutionResult(resolution) {
  switch (resolution.state) {
    case 'DESTINATION_FOUND':
    case 'destination_found':
      return formatSuccessMessage(resolution);
    case 'VERIFICATION_REQUIRED':
    case 'verification_required':
      return formatVerificationRequiredMessage();
    case 'DESTINATION_NOT_FOUND':
      return formatDestinationNotExposedMessage();
    case 'TIMEOUT':
    case 'timeout':
      return formatTimeoutMessage();
    default:
      return resolution.success
        ? formatSuccessMessage(resolution)
        : formatErrorMessage(resolution.error || 'Resolution failed');
  }
}

export default {
  formatStartMessage,
  formatHelpMessage,
  formatProcessingMessage,
  formatDuplicateJobMessage,
  formatInvalidUrlMessage,
  formatCatalogueTelegramSummary,
  formatSuccessMessage,
  formatDestinationNotExposedMessage,
  formatVerificationRequiredMessage,
  formatTimeoutMessage,
  formatErrorMessage,
  formatStatusMessage,
  formatResolutionResult,
  splitTelegramMessage,
};
