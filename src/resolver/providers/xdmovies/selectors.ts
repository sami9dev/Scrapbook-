/**
 * XDMovies page selectors and detection patterns for top.xdmovies.wtf.
 * Section 8 of the specification.
 */

export const MEDIATOR_FLOW = {
  GENERATE_LINK: /generate\s*link/i,
  STEP_1_WAIT: /step\s*1\s*of\s*2|please\s*wait/i,
  STEP_1_DONE: /step\s*1\s*complete|continue\s*to\s*step\s*2/i,
  STEP_2_WAIT: /step\s*2\s*of\s*2|almost\s*there/i,
  CAPTCHA_SUCCESS: /success!|your\s*link\s*is\s*ready/i,
  GO_TO_LINK: /go\s*to\s*link/i,
} as const;

export const XDMOVIES_META_SELECTORS = {
  title: ['h1.entry-title', 'h1', 'title'],
  poster: ['img.entry-image', '.thumb img', '.post-thumbnail img', 'article img'],
  description: ['.entry-content p', '.post-content p', 'article p'],
  genres: ['.genres a', '.tags a', '.genre'],
  releaseDate: ['.release-date', '.date', 'time[datetime]'],
} as const;

export const CHALLENGE_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="hcaptcha"]',
  '.cf-turnstile',
  '#challenge-stage',
  '#turnstile-wrapper',
  '.g-recaptcha',
  '.h-captcha',
] as const;

export const CHALLENGE_TEXT_PATTERNS = [
  /just a moment/i,
  /checking your browser/i,
  /enable javascript/i,
  /ddos protection/i,
  /cloudflare/i,
] as const;
