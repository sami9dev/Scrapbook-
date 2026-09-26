/**
 * Resilient selector and regex patterns for 4KHDHub content pages.
 * Strictly adheres to Section 5 ("4KHDHub extraction stage") of the specification.
 */

export const HUBCLOUD_BUTTON_PATTERNS = [
  /download\s+hubcloud/i,
  /hubcloud\s+download/i,
  /hubcloud/i,
];

export const QUALITY_PATTERNS = [
  { label: '2160p', regex: /\b(2160p|4k|uhd)\b/i },
  { label: '1080p', regex: /\b(1080p|fhd)\b/i },
  { label: '720p', regex: /\b(720p|hd)\b/i },
  { label: '480p', regex: /\b(480p|sd)\b/i },
];

export const EPISODE_PATTERNS = [
  /s(\d{1,2})e(\d{1,2})/i,
  /season\s*(\d{1,2})\s*episode\s*(\d{1,2})/i,
  /episode\s*(\d{1,2})/i,
  /ep\s*(\d{1,2})/i,
];

export const SEASON_PATTERNS = [
  /s(\d{1,2})/i,
  /season\s*(\d{1,2})/i,
];

export const LANGUAGE_PATTERNS = [
  { label: 'Hindi', regex: /\bhindi\b/i },
  { label: 'English', regex: /\benglish\b/i },
  { label: 'Tamil', regex: /\btamil\b/i },
  { label: 'Telugu', regex: /\btelugu\b/i },
  { label: 'Multi Audio', regex: /\b(multi|dual)\s*audio\b/i },
];

export const CONTENT_SELECTORS = [
  '.entry-content',
  '.download-links',
  '.content-post',
  '.post-inner',
  'article',
  'main',
  'body',
];

export default {
  HUBCLOUD_BUTTON_PATTERNS,
  QUALITY_PATTERNS,
  EPISODE_PATTERNS,
  SEASON_PATTERNS,
  LANGUAGE_PATTERNS,
  CONTENT_SELECTORS,
};
