/**
 * Structured logger with tag prefixes and strict redaction of sensitive credentials,
 * auth headers, tokens, passwords, and cookies.
 */

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'access_token',
  'refreshtoken',
  'password',
  'secret',
  'api_key',
  'apikey',
  'session',
]);

/**
 * Sanitizes any object or string to prevent logging credentials.
 */
export function sanitizeData(data) {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    // Redact Bearer tokens and authorization headers
    return data
      .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
      .replace(/(token|password|secret|key)=([a-zA-Z0-9_\-\.]+)/gi, '$1=[REDACTED]');
  }
  if (Array.isArray(data)) {
    return data.map(sanitizeData);
  }
  if (typeof data === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        cleaned[key] = '[REDACTED]';
      } else {
        cleaned[key] = sanitizeData(value);
      }
    }
    return cleaned;
  }
  return data;
}

class Logger {
  constructor(options = {}) {
    this.silent = options.silent || false;
  }

  formatMessage(tag, message, meta) {
    const timestamp = new Date().toISOString();
    const cleanMsg = typeof message === 'string' ? sanitizeData(message) : JSON.stringify(sanitizeData(message));
    if (meta !== undefined) {
      const cleanMeta = JSON.stringify(sanitizeData(meta));
      return `[${timestamp}] [${tag}] ${cleanMsg} ${cleanMeta}`;
    }
    return `[${timestamp}] [${tag}] ${cleanMsg}`;
  }

  log(tag, message, meta) {
    if (this.silent) return;
    const formatted = this.formatMessage(tag, message, meta);
    console.log(formatted);
  }

  discovered(message, meta) {
    this.log('DISCOVERED', message, meta);
  }

  redirect(message, meta) {
    this.log('REDIRECT', message, meta);
  }

  parsing(message, meta) {
    this.log('PARSING', message, meta);
  }

  provider(message, meta) {
    this.log('PROVIDER', message, meta);
  }

  metadata(message, meta) {
    this.log('METADATA', message, meta);
  }

  database(message, meta) {
    this.log('DATABASE', message, meta);
  }

  warning(message, meta) {
    if (this.silent) return;
    const formatted = this.formatMessage('WARNING', message, meta);
    console.warn(formatted);
  }

  error(message, meta) {
    if (this.silent) return;
    const formatted = this.formatMessage('ERROR', message, meta);
    console.error(formatted);
  }

  security(message, meta) {
    if (this.silent) return;
    const formatted = this.formatMessage('SECURITY', message, meta);
    console.warn(formatted);
  }
}

export const logger = new Logger();
export default logger;
