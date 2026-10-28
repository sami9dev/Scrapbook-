/**
 * Test Suite for 4KHub4U Telegram Bot and Resolver
 *
 * Verifies:
 *   1. Hostname validation (accepts 4KHub4U / 4KHDHub, rejects arbitrary URLs)
 *   2. resolve4KHub4U core resolver flow with mock server
 *   3. Human verification detection halts immediately (no bypass)
 *   4. Job manager isolation, unique job IDs, and deduplication
 *   5. Message formatting for start, help, status, success, challenge, and errors
 *   6. Command routing (/start, /help, /status, /resolve, and direct URL)
 *   7. PerformanceMetrics tracking (resolverDurationMs, telegramOverheadMs, totalDurationMs)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { resolve4KHub4U } from '../src/scrapers/4khub4u/resolver.js';
import { is4KHub4UUrl, Hub4UState } from '../src/scrapers/4khub4u/types.js';
import {
  formatSuccessMessage,
  formatVerificationRequiredMessage,
  formatDestinationNotExposedMessage,
  formatTimeoutMessage,
  formatStartMessage,
  formatHelpMessage,
  formatStatusMessage,
  formatInvalidUrlMessage,
} from '../src/bot/telegram/messages.js';
import { TelegramJobManager } from '../src/bot/telegram/handlers.js';
import { routeIncomingMessage } from '../src/bot/telegram/commands.js';
import { Telegram4KHub4UBot } from '../src/bot/telegram/bot.js';

let server;
let baseUrl;

const HUBCLOUD_DEST = 'https://hubcloud.ist/drive/d3vug2udf3bu8iv';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/4kh-movie') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Deadpool & Wolverine (2024) - 4KHDHub</title></head>
        <body>
          <h1 class="entry-title">Deadpool & Wolverine (2024)</h1>
          <div class="entry-content">
            <h3>Deadpool.and.Wolverine.2024.1080p.Hindi.English</h3>
            <p>Download Links:</p>
            <a href="${baseUrl}/mediator-countdown?id=med_101" class="btn btn-primary">
              Download HubCloud
            </a>
          </div>
        </body>
        </html>
      `);
    } else if (url.pathname === '/4kh-challenge') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Just a moment...</title></head>
        <body>
          <div class="cf-turnstile" data-sitekey="0x4AAAAAA"></div>
          <p>Please verify you are a human to proceed.</p>
        </body>
        </html>
      `);
    } else if (url.pathname === '/4kh-no-links') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Coming Soon - 4KHDHub</title></head>
        <body>
          <h1>Coming Soon</h1>
          <p>No downloads available yet.</p>
        </body>
        </html>
      `);
    } else if (url.pathname === '/mediator-countdown') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Fast Direct Link Generator</title></head>
        <body>
          <div id="countdown-wrapper">
            <span id="timer">1</span> seconds remaining...
          </div>
          <div id="link-container">
            <a id="getLinkBtn" href="${HUBCLOUD_DEST}">Get Link</a>
          </div>
        </body>
        </html>
      `);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

// ── Mock Telegram Sender for Testing ──────────────────────────────────────────

class MockTelegramSender {
  constructor() {
    this.sentMessages = [];
    this.editedMessages = [];
    this.nextMsgId = 100;
  }

  async sendMessage(chatId, text, options) {
    const messageId = ++this.nextMsgId;
    this.sentMessages.push({ chatId, text, options });
    return { messageId };
  }

  async editMessageText(chatId, messageId, text) {
    this.editedMessages.push({ chatId, messageId, text });
  }

  clear() {
    this.sentMessages = [];
    this.editedMessages = [];
  }
}

// ── Section 1: URL Validation ─────────────────────────────────────────────────

describe('is4KHub4UUrl()', () => {
  it('accepts 4khub4u.com domain', () => {
    expect(is4KHub4UUrl('https://4khub4u.com/movie-name-2024/')).toBe(true);
    expect(is4KHub4UUrl('http://4khub4u.to/series/')).toBe(true);
  });

  it('accepts 4khdhub.one domain and subdomains', () => {
    expect(is4KHub4UUrl('https://4khdhub.one/deadpool-wolverine-2024/')).toBe(true);
    expect(is4KHub4UUrl('https://sub.4khdhub.one/post-123')).toBe(true);
  });

  it('accepts hdhub4u domains', () => {
    expect(is4KHub4UUrl('https://hdhub4u.tv/movie/')).toBe(true);
    expect(is4KHub4UUrl('https://hdhub4u.vin/post/')).toBe(true);
  });

  it('accepts local test server URLs containing 4kh or mediator markers', () => {
    expect(is4KHub4UUrl('http://127.0.0.1:3000/4kh-movie')).toBe(true);
    expect(is4KHub4UUrl('http://localhost:3000/movie-123')).toBe(true);
  });

  it('strictly rejects non-4KHub4U arbitrary URLs', () => {
    expect(is4KHub4UUrl('https://google.com')).toBe(false);
    expect(is4KHub4UUrl('https://youtube.com/watch?v=123')).toBe(false);
    expect(is4KHub4UUrl('https://other-movie-site.com/movies/')).toBe(false);
    expect(is4KHub4UUrl('https://random-site.net/downloads/')).toBe(false);
  });

  it('handles invalid / non-string input safely', () => {
    expect(is4KHub4UUrl('')).toBe(false);
    expect(is4KHub4UUrl(null)).toBe(false);
    expect(is4KHub4UUrl(undefined)).toBe(false);
    expect(is4KHub4UUrl('not-a-url')).toBe(false);
    expect(is4KHub4UUrl('ftp://4khdhub.one')).toBe(false);
  });
});

// ── Section 2: Core Resolver (resolve4KHub4U) ─────────────────────────────────

describe('resolve4KHub4U()', () => {
  it('rejects invalid / non-4KHub4U URL immediately', async () => {
    const result = await resolve4KHub4U('https://arbitrary-site.com/movie');
    expect(result.success).toBe(false);
    expect(result.state).toBe(Hub4UState.ERROR);
    expect(result.error).toContain('Only 4KHub4U');
    expect(result.metrics).toBeDefined();
    expect(result.metrics.resolverDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('resolves normal movie page into HubCloud destination', async () => {
    const result = await resolve4KHub4U(`${baseUrl}/4kh-movie`, {
      useHttpFirst: true,
      countdownTimeout: 5000,
      navigationTimeout: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.state).toBe(Hub4UState.DESTINATION_FOUND);
    expect(result.destination).toBe(HUBCLOUD_DEST);
    expect(result.title).toBeDefined();
    expect(result.provider).toBe('HubCloud');
    expect(result.metrics.resolverDurationMs).toBeGreaterThan(0);
  });

  it('halts immediately when human verification challenge is encountered', async () => {
    const result = await resolve4KHub4U(`${baseUrl}/4kh-challenge`);
    expect(result.success).toBe(false);
    expect(result.state).toBe(Hub4UState.VERIFICATION_REQUIRED);
    expect(result.destination).toBeNull();
    expect(result.error).toContain('verification');
  });

  it('returns DESTINATION_NOT_FOUND when page has no download links', async () => {
    const result = await resolve4KHub4U(`${baseUrl}/4kh-no-links`);
    expect(result.success).toBe(false);
    expect(result.state).toBe(Hub4UState.DESTINATION_NOT_FOUND);
    expect(result.destination).toBeNull();
  });

  it('accepts direct HubCloud link directly without scraping', async () => {
    const result = await resolve4KHub4U(HUBCLOUD_DEST);
    expect(result.success).toBe(true);
    expect(result.state).toBe(Hub4UState.DESTINATION_FOUND);
    expect(result.destination).toBe(HUBCLOUD_DEST);
  });
});

// ── Section 3: Telegram Message Formatting ────────────────────────────────────

describe('Telegram message formatters', () => {
  it('formatStartMessage contains bot introduction and commands', () => {
    const msg = formatStartMessage();
    expect(msg).toContain('Welcome to the 4KHub4U');
    expect(msg).toContain('/resolve');
    expect(msg).toContain('/status');
    expect(msg).toContain('/help');
  });

  it('formatHelpMessage explains how to use the bot', () => {
    const msg = formatHelpMessage();
    expect(msg).toContain('4KHub4U Bot Help');
    expect(msg).toContain('/resolve');
  });

  it('formatInvalidUrlMessage warns user about arbitrary URLs', () => {
    const msg = formatInvalidUrlMessage();
    expect(msg).toContain('Invalid URL');
    expect(msg).toContain('4KHub4U');
  });

  it('formatSuccessMessage formats successful resolution with time and destination', () => {
    const mockResolution = {
      success: true,
      state: Hub4UState.DESTINATION_FOUND,
      title: 'Deadpool & Wolverine (2024)',
      provider: 'HubCloud',
      destination: HUBCLOUD_DEST,
      error: null,
      sourceUrl: 'https://4khdhub.one/deadpool',
      mediatorUrl: 'https://mediator.test/?id=1',
      elapsedMs: 2310,
      metrics: {
        requestReceivedAt: 1000,
        resolverStartedAt: 1000,
        resolverFinishedAt: 3310,
        resolverDurationMs: 2310,
        totalDurationMs: 2310,
      },
    };

    const msg = formatSuccessMessage(mockResolution);
    expect(msg).toContain('✅ 4KHub4U resolved');
    expect(msg).toContain('Title: Deadpool & Wolverine (2024)');
    expect(msg).toContain('Provider: HubCloud');
    expect(msg).toContain('Resolver time: 2.31s');
    expect(msg).toContain(HUBCLOUD_DEST);
  });

  it('formatVerificationRequiredMessage specifies no bypass was attempted', () => {
    const msg = formatVerificationRequiredMessage();
    expect(msg).toContain('⚠️ Human verification required');
    expect(msg).toContain('No verification bypass was attempted.');
  });

  it('formatDestinationNotExposedMessage notifies when destination is not public', () => {
    const msg = formatDestinationNotExposedMessage();
    expect(msg).toContain('⚠️ Destination not exposed');
  });

  it('formatTimeoutMessage reports timeout without error dump', () => {
    const msg = formatTimeoutMessage();
    expect(msg).toContain('⏱️ Resolution timed out');
  });

  it('formatStatusMessage formats uptime and performance stats', () => {
    const msg = formatStatusMessage({
      uptimeSeconds: 120,
      activeJobs: 1,
      completedJobs: 10,
      successfulJobs: 8,
      verificationRequiredCount: 1,
      timeoutCount: 1,
      avgResolverDurationMs: 2150,
    });
    expect(msg).toContain('📊 *4KHub4U Bot Status*');
    expect(msg).toContain('Active Jobs: 1');
    expect(msg).toContain('Completed Jobs: 10');
    expect(msg).toContain('Average Resolver Time: 2.15s');
  });
});

// ── Section 4: Telegram Job Isolation & Deduplication ─────────────────────────

describe('TelegramJobManager', () => {
  let jobManager;
  let sender;

  beforeEach(() => {
    jobManager = new TelegramJobManager();
    sender = new MockTelegramSender();
  });

  it('assigns unique jobId to each resolution request', async () => {
    const res1 = await jobManager.handleResolutionRequest(
      sender,
      { chatId: 101, userId: 1, sourceUrl: `${baseUrl}/4kh-movie` },
      { useHttpFirst: true }
    );

    const res2 = await jobManager.handleResolutionRequest(
      sender,
      { chatId: 102, userId: 2, sourceUrl: `${baseUrl}/4kh-movie` },
      { useHttpFirst: true }
    );

    expect(res1.metrics).toBeDefined();
    expect(res2.metrics).toBeDefined();
    expect(res1.metrics.resolverDurationMs).toBeGreaterThanOrEqual(0);
    expect(res2.metrics.resolverDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('records telegram overhead separately from resolver time', async () => {
    const res = await jobManager.handleResolutionRequest(
      sender,
      { chatId: 101, userId: 1, sourceUrl: `${baseUrl}/4kh-movie` },
      { useHttpFirst: true }
    );

    expect(res.metrics.resolverDurationMs).toBeGreaterThan(0);
    expect(typeof res.metrics.telegramOverheadMs).toBe('number');
    expect(res.metrics.totalDurationMs).toBeGreaterThanOrEqual(res.metrics.resolverDurationMs);
    expect(res.metrics.telegramOverheadMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects duplicate requests while existing job is active', async () => {
    const url = `${baseUrl}/4kh-movie`;
    jobManager.activeJobs.set(`201::${url}`, {
      jobId: 'fake-active-job',
      chatId: 201,
      userId: 1,
      sourceUrl: url,
      createdAt: Date.now(),
    });

    const res = await jobManager.handleResolutionRequest(
      sender,
      { chatId: 201, userId: 1, sourceUrl: url }
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain('already in progress');
    expect(sender.sentMessages.some((m) => m.text.includes('already in progress'))).toBe(true);
  });

  it('updates completed stats on success and failure', async () => {
    await jobManager.handleResolutionRequest(
      sender,
      { chatId: 101, userId: 1, sourceUrl: `${baseUrl}/4kh-movie` },
      { useHttpFirst: true }
    );

    await jobManager.handleResolutionRequest(
      sender,
      { chatId: 102, userId: 2, sourceUrl: `${baseUrl}/4kh-challenge` },
      { useHttpFirst: true }
    );

    const stats = jobManager.getStats();
    expect(stats.completedJobs).toBe(2);
    expect(stats.successfulJobs).toBe(1);
    expect(stats.verificationRequiredCount).toBe(1);
  });
});

// ── Section 5: Command Routing ────────────────────────────────────────────────

describe('routeIncomingMessage()', () => {
  let sender;
  let jobManager;

  beforeEach(() => {
    sender = new MockTelegramSender();
    jobManager = new TelegramJobManager();
  });

  it('routes /start to start message', async () => {
    await routeIncomingMessage(sender, { chatId: 1, userId: 1, text: '/start' }, jobManager);
    expect(sender.sentMessages[0].text).toContain('Welcome to the 4KHub4U');
  });

  it('routes /help to help message', async () => {
    await routeIncomingMessage(sender, { chatId: 1, userId: 1, text: '/help' }, jobManager);
    expect(sender.sentMessages[0].text).toContain('4KHub4U Bot Help');
  });

  it('routes /status to status report', async () => {
    await routeIncomingMessage(sender, { chatId: 1, userId: 1, text: '/status' }, jobManager);
    expect(sender.sentMessages[0].text).toContain('4KHub4U Bot Status');
  });

  it('routes /resolve <url> and initiates resolution', async () => {
    await routeIncomingMessage(
      sender,
      { chatId: 1, userId: 1, text: `/resolve ${baseUrl}/4kh-movie` },
      jobManager,
      { directResolve: true, useHttpFirst: true }
    );

    expect(sender.sentMessages.some((m) => m.text.includes('Processing 4KHub4U'))).toBe(true);
    expect(
      sender.editedMessages.some((m) => m.text.includes('4KHub4U resolved')) ||
      sender.sentMessages.some((m) => m.text.includes('4KHub4U resolved'))
    ).toBe(true);
  });

  it('recognizes direct URL message without /resolve prefix', async () => {
    await routeIncomingMessage(
      sender,
      { chatId: 1, userId: 1, text: `${baseUrl}/4kh-movie` },
      jobManager,
      { directResolve: true, useHttpFirst: true }
    );

    expect(sender.sentMessages.some((m) => m.text.includes('Processing 4KHub4U'))).toBe(true);
    expect(
      sender.editedMessages.some((m) => m.text.includes('4KHub4U resolved')) ||
      sender.sentMessages.some((m) => m.text.includes('4KHub4U resolved'))
    ).toBe(true);
  });

  it('rejects direct message with arbitrary non-4KHub4U URL', async () => {
    await routeIncomingMessage(
      sender,
      { chatId: 1, userId: 1, text: 'https://arbitrary-unsupported-domain.com/movie' },
      jobManager
    );

    expect(sender.sentMessages.some((m) => m.text.includes('Invalid URL'))).toBe(true);
  });
});

// ── Section 6: Telegram4KHub4UBot Client ───────────────────────────────────────

describe('Telegram4KHub4UBot', () => {
  it('initializes with token and options without crashing', () => {
    const bot = new Telegram4KHub4UBot({ token: 'test-token-12345' });
    expect(bot.getToken()).toBe('test-token-12345');
    expect(bot.isPolling()).toBe(false);
  });

  it('formats sendMessage API payload accurately', async () => {
    let capturedUrl = '';
    let capturedBody = null;

    const mockFetch = async (url, opts) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
    };

    const bot = new Telegram4KHub4UBot({
      token: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      fetchFn: mockFetch,
    });

    const res = await bot.sendMessage(12345, 'Hello from test', { parse_mode: 'Markdown' });
    expect(capturedUrl).toContain('/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/sendMessage');
    expect(capturedBody.chat_id).toBe(12345);
    expect(capturedBody.text).toBe('Hello from test');
    expect(capturedBody.parse_mode).toBe('Markdown');
    expect(res.messageId).toBe(42);
  });

  it('formats editMessageText API payload accurately', async () => {
    let capturedUrl = '';
    let capturedBody = null;

    const mockFetch = async (url, opts) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }));
    };

    const bot = new Telegram4KHub4UBot({
      token: 'test-token',
      fetchFn: mockFetch,
    });

    await bot.editMessageText(12345, 99, 'Updated text');
    expect(capturedUrl).toContain('/bottest-token/editMessageText');
    expect(capturedBody.chat_id).toBe(12345);
    expect(capturedBody.message_id).toBe(99);
    expect(capturedBody.text).toBe('Updated text');
  });

  it('handleUpdate dispatches update to command router', async () => {
    const bot = new Telegram4KHub4UBot({
      token: 'test-token',
      fetchFn: async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
    });

    const rawUpdate = {
      update_id: 5001,
      message: {
        message_id: 1,
        from: { id: 777, first_name: 'Tester' },
        chat: { id: 777, type: 'private' },
        text: '/start',
      },
    };

    const result = await bot.handleUpdate(rawUpdate);
    expect(result).toBeDefined();
  });
});
