import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateUrl, resolveRelativeUrl, isPrivateIPv4, isPrivateIPv6 } from '../src/utils/url.js';
import { logger, sanitizeData } from '../src/logging/logger.js';
import { parseHtml, detectHumanVerificationChallenge } from '../src/parsing/html-parser.js';
import { resolveRedirects, RedirectLimitExceededError } from '../src/discovery/redirect-resolver.js';
import { fetchWithControls } from '../src/discovery/http-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '../fixtures');

describe('Phase 1: URL Validation & SSRF Prevention', () => {
  it('allows valid http and https URLs', () => {
    const res1 = validateUrl('https://example-authorized-site.test/tvshows/example-show/');
    expect(res1.valid).toBe(true);
    expect(res1.normalizedUrl).toBe('https://example-authorized-site.test/tvshows/example-show/');

    const res2 = validateUrl('http://gdflix.example/file/123');
    expect(res2.valid).toBe(true);
  });

  it('rejects disallowed protocols (file:, ftp:, javascript:)', () => {
    expect(validateUrl('file:///etc/passwd').valid).toBe(false);
    expect(validateUrl('ftp://ftp.example.com').valid).toBe(false);
    expect(validateUrl('javascript:alert(1)').valid).toBe(false);
  });

  it('rejects URLs with embedded credentials', () => {
    const res = validateUrl('https://user:password@example-authorized-site.test');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/embedded credentials/i);
  });

  it('blocks private IPv4 addresses (SSRF prevention)', () => {
    expect(validateUrl('http://127.0.0.1:8080/test').valid).toBe(false);
    expect(validateUrl('http://10.0.0.5/api').valid).toBe(false);
    expect(validateUrl('http://192.168.1.100').valid).toBe(false);
    expect(validateUrl('http://172.20.0.1').valid).toBe(false);
    expect(validateUrl('http://169.254.169.254/latest/meta-data').valid).toBe(false);
    expect(validateUrl('http://localhost:3000').valid).toBe(false);
  });

  it('blocks private and loopback IPv6 addresses', () => {
    expect(validateUrl('http://[::1]:8080').valid).toBe(false);
    expect(validateUrl('http://[fc00::1]').valid).toBe(false);
    expect(validateUrl('http://[fe80::1]').valid).toBe(false);
    expect(validateUrl('http://[::ffff:192.168.1.1]').valid).toBe(false);
  });

  it('enforces explicit domain allowlist when configured', () => {
    const options = { allowedDomains: ['example-authorized-site.test', 'gdflix.example'] };
    
    expect(validateUrl('https://example-authorized-site.test/path', options).valid).toBe(true);
    expect(validateUrl('https://sub.example-authorized-site.test/path', options).valid).toBe(true);
    expect(validateUrl('https://gdflix.example/file/123', options).valid).toBe(true);
    
    const disallowed = validateUrl('https://unauthorized-evil-site.test/path', options);
    expect(disallowed.valid).toBe(false);
    expect(disallowed.error).toMatch(/authorized domain allowlist/i);
  });

  it('correctly identifies private IPv4 and IPv6 ranges', () => {
    expect(isPrivateIPv4('127.0.0.1')).toBe(true);
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateIPv6('::1')).toBe(true);
    expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false);
  });
});

describe('Phase 1: Relative URL Resolution', () => {
  const base = 'https://example-authorized-site.test/tvshows/example-show/';

  it('resolves root-relative path against page origin', () => {
    const resolved = resolveRelativeUrl(base, '/some/path');
    expect(resolved).toBe('https://example-authorized-site.test/some/path');
  });

  it('resolves relative path with folder context', () => {
    const resolved = resolveRelativeUrl(base, 'episodes/1');
    expect(resolved).toBe('https://example-authorized-site.test/tvshows/example-show/episodes/1');
  });

  it('resolves parent path ../ and ../../', () => {
    const resolvedOneUp = resolveRelativeUrl(base, '../movies');
    expect(resolvedOneUp).toBe('https://example-authorized-site.test/tvshows/movies');

    const resolvedTwoUp = resolveRelativeUrl(base, '../../movies');
    expect(resolvedTwoUp).toBe('https://example-authorized-site.test/movies');
  });

  it('preserves full absolute URLs', () => {
    const resolved = resolveRelativeUrl(base, 'https://provider.example/file/ABC123');
    expect(resolved).toBe('https://provider.example/file/ABC123');
  });

  it('ignores invalid or pseudo-protocols', () => {
    expect(resolveRelativeUrl(base, 'javascript:void(0)')).toBeNull();
    expect(resolveRelativeUrl(base, 'data:text/html,bad')).toBeNull();
    expect(resolveRelativeUrl(base, '#anchor')).toBeNull();
  });
});

describe('Phase 1: HTML Parser & Challenge Interception', () => {
  it('detects Cloudflare Turnstile / CAPTCHA from fixture without bypassing', () => {
    const captchaHtml = fs.readFileSync(path.join(fixturesDir, 'captcha-page.html'), 'utf-8');
    const result = parseHtml(captchaHtml, 'https://example-authorized-site.test/protected');

    expect(result.success).toBe(false);
    expect(result.challenge).toBe(true);
    expect(result.challengeResult.status).toBe('HUMAN_VERIFICATION_REQUIRED');
    expect(result.challengeResult.message).toBe('Manual verification required.');
  });

  it('extracts canonical URL and meta refresh from redirect-page fixture', () => {
    const redirectHtml = fs.readFileSync(path.join(fixturesDir, 'redirect-page.html'), 'utf-8');
    const result = parseHtml(redirectHtml, 'https://example-authorized-site.test/intermediate');

    expect(result.success).toBe(true);
    expect(result.challenge).toBe(false);
    expect(result.metaRefresh).toBe('https://example-authorized-site.test/destination');
    expect(result.canonicalUrl).toBe('https://example-authorized-site.test/canonical-destination');
    expect(result.links.length).toBeGreaterThan(0);
    expect(result.links[0].href).toBe('https://example-authorized-site.test/destination');
  });

  it('safely parses malformed HTML without crashing', () => {
    const malformedHtml = fs.readFileSync(path.join(fixturesDir, 'malformed-page.html'), 'utf-8');
    const result = parseHtml(malformedHtml, 'https://example-authorized-site.test/malformed');

    expect(result.success).toBe(true);
    expect(result.challenge).toBe(false);
    // Should extract valid link and skip javascript/data/hash links
    const validLink = result.links.find((l) => l.href.includes('/valid-link'));
    expect(validLink).toBeDefined();
    const jsLink = result.links.find((l) => l.href.includes('javascript'));
    expect(jsLink).toBeUndefined();
  });
});

describe('Phase 1: Logging & Credential Redaction', () => {
  it('redacts sensitive authorization headers, tokens, and passwords', () => {
    const sensitive = {
      authorization: 'Bearer secret_token_12345',
      cookie: 'session_id=abcdef98765',
      user: 'alice',
      password: 'super_secret_password',
      token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    };

    const sanitized = sanitizeData(sensitive);
    expect(sanitized.authorization).toBe('[REDACTED]');
    expect(sanitized.cookie).toBe('[REDACTED]');
    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.token).toBe('[REDACTED]');
    expect(sanitized.user).toBe('alice');
  });

  it('redacts inline Bearer tokens in string logs', () => {
    const message = 'Sending request with header: Bearer abc123def456 and token=mysecretvalue';
    const sanitized = sanitizeData(message);
    expect(sanitized).toContain('Bearer [REDACTED]');
    expect(sanitized).toContain('token=[REDACTED]');
    expect(sanitized).not.toContain('abc123def456');
    expect(sanitized).not.toContain('mysecretvalue');
  });
});

describe('Phase 1: Redirect Resolution & Safety', () => {
  it('follows 301, 302, 307 redirects and records redirect chain', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('', {
        status: 301,
        headers: { Location: '/step1' }
      }))
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { Location: 'https://example-authorized-site.test/step2' }
      }))
      .mockResolvedValueOnce(new Response('<html><body>Final Target</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      }));

    const result = await resolveRedirects('https://example-authorized-site.test/start', {
      fetchFn: mockFetch,
    });

    expect(result.status).toBe(200);
    expect(result.originalUrl).toBe('https://example-authorized-site.test/start');
    expect(result.redirectChain).toEqual([
      'https://example-authorized-site.test/step1',
      'https://example-authorized-site.test/step2',
    ]);
    expect(result.finalUrl).toBe('https://example-authorized-site.test/step2');
    expect(result.body).toContain('Final Target');
  });

  it('enforces MAX_REDIRECTS and throws REDIRECT_LIMIT_EXCEEDED', async () => {
    let count = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      count++;
      return Promise.resolve(new Response('', {
        status: 302,
        headers: { Location: `/hop-${count}` }
      }));
    });

    await expect(
      resolveRedirects('https://example-authorized-site.test/start', {
        maxRedirects: 3,
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(RedirectLimitExceededError);
  });

  it('detects circular redirect loops', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { Location: 'https://example-authorized-site.test/loop-b' }
      }))
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { Location: 'https://example-authorized-site.test/loop-a' }
      }))
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { Location: 'https://example-authorized-site.test/loop-b' }
      }));

    await expect(
      resolveRedirects('https://example-authorized-site.test/loop-a', {
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(/Redirect loop detected/i);
  });

  it('blocks redirects that target private internal IP addresses (SSRF during redirect)', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(new Response('', {
      status: 302,
      headers: { Location: 'http://169.254.169.254/latest/meta-data' }
    }));

    await expect(
      resolveRedirects('https://example-authorized-site.test/forwarder', {
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(/SSRF blocked/i);
  });
});

describe('Phase 1: HTTP Client Retries & Challenge Non-Retry', () => {
  it('retries temporary 500 errors with backoff and succeeds on subsequent attempt', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
      .mockResolvedValueOnce(new Response('OK Page Content', { status: 200 }));

    const res = await fetchWithControls('https://example-authorized-site.test/flaky', {
      maxRetries: 2,
      backoffDelays: [1, 2], // 1ms, 2ms for fast tests
      fetchFn: mockFetch,
    });

    expect(res.success).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toBe('OK Page Content');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry 401 Unauthorized or 403 Forbidden', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

    const res = await fetchWithControls('https://example-authorized-site.test/private', {
      maxRetries: 2,
      fetchFn: mockFetch,
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe(403);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No retries
  });

  it('does NOT retry when Cloudflare Turnstile / CAPTCHA is detected', async () => {
    const captchaHtml = fs.readFileSync(path.join(fixturesDir, 'captcha-page.html'), 'utf-8');
    const mockFetch = vi.fn().mockResolvedValueOnce(new Response(captchaHtml, { status: 200 }));

    const res = await fetchWithControls('https://example-authorized-site.test/challenge', {
      maxRetries: 2,
      fetchFn: mockFetch,
    });

    expect(res.success).toBe(false);
    expect(res.verificationRequired).toBe(true);
    expect(res.challengeResult.status).toBe('HUMAN_VERIFICATION_REQUIRED');
    expect(mockFetch).toHaveBeenCalledTimes(1); // No retries
  });
});
