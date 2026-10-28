import { describe, it, expect, vi } from 'vitest';
import {
  LinkState,
  LinkStateMachine,
  detectPage,
  extractCountdown,
  extractHubCloudUrl,
  assertTransition,
  type PageSnapshot,
} from '../src/state-machine/link-state-machine.js';
import { processLink } from '../src/state-machine/link-worker.js';

describe('Link State Machine Test Suite (Sections 1-28)', () => {
  // Test 1: Cloudflare page -> CHALLENGE_REQUIRED
  it('detects Cloudflare security challenge page and returns CHALLENGE_REQUIRED', () => {
    const snapshot: PageSnapshot = {
      url: 'https://example-mediator.com/r/xyz',
      status: 403,
      html: `
        <!DOCTYPE html>
        <html>
        <head><title>Just a moment...</title></head>
        <body>
          <p>Enable JavaScript and cookies to continue</p>
        </body>
        </html>
      `,
      timestamp: Date.now(),
    };

    const result = detectPage(snapshot);
    expect(result.state).toBe(LinkState.CHALLENGE_REQUIRED);
    expect(result.reason).toContain('challenge detected');
  });

  // Test 2: Turnstile page -> CHALLENGE_REQUIRED
  it('detects Cloudflare Turnstile iframe/widget and returns CHALLENGE_REQUIRED', () => {
    const snapshot: PageSnapshot = {
      url: 'https://example-mediator.com/r/xyz',
      status: 200,
      html: `
        <div id="cf-challenge">
          <iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/v0/api.js"></iframe>
          <div class="cf-turnstile"></div>
        </div>
      `,
      timestamp: Date.now(),
    };

    const result = detectPage(snapshot);
    expect(result.state).toBe(LinkState.CHALLENGE_REQUIRED);
  });

  // Test 3: Section 22 test of supplied Cloudflare response
  it('classifies supplied Cloudflare response as CHALLENGE_REQUIRED and NOT as MEDIATOR or DESTINATION_FOUND or SUCCESS', () => {
    const cfHtml = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>Just a moment...</title>
      </head>
      <body>
        <div class="main-content">
          <h1>Please wait while your request is verified</h1>
          <p>Enable JavaScript and cookies to continue</p>
          <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
          <!-- Even if mediator text or fake link exists in ad/spoof content -->
          <a href="https://hubcloud.ist/drive/fake12345">Get Link</a>
        </div>
      </body>
      </html>
    `;

    const result = detectPage({
      url: 'https://latestnewsonline.sbs/r/test',
      status: 403,
      html: cfHtml,
      timestamp: Date.now(),
    });

    expect(result.state).toBe(LinkState.CHALLENGE_REQUIRED);
    expect(result.state).not.toBe(LinkState.MEDIATOR);
    expect(result.state).not.toBe(LinkState.DESTINATION_FOUND);
    expect(result.state).not.toBe(LinkState.SUCCESS);
  });

  // Test 4: Mediator page -> MEDIATOR
  it('detects Mediator page when mediator patterns are found without countdown', () => {
    const snapshot: PageSnapshot = {
      url: 'https://mediator.biz/step-1',
      status: 200,
      html: `
        <div class="container">
          <h2>Latest News Online</h2>
          <button id="get-link">Get Link</button>
          <a href="/step-2">Continue to Step 2</a>
        </div>
      `,
      timestamp: Date.now(),
    };

    const result = detectPage(snapshot);
    expect(result.state).toBe(LinkState.MEDIATOR);
    expect(result.reason).toContain('Mediator page detected');
  });

  // Test 5: Countdown page -> WAITING
  it('detects Countdown page and returns WAITING with extracted duration in ms', () => {
    const snapshot: PageSnapshot = {
      url: 'https://mediator.biz/step-1',
      status: 200,
      html: `
        <div class="timer-box">
          <p>Please wait 8 seconds before link is generated</p>
          <div id="countdown">8 sec</div>
        </div>
      `,
      timestamp: Date.now(),
    };

    const result = detectPage(snapshot);
    expect(result.state).toBe(LinkState.WAITING);
    if (result.state === LinkState.WAITING) {
      expect(result.remainingMs).toBe(8000);
      expect(result.reason).toContain('Countdown detected: 8000ms');
    }
  });

  // Test 6: Section 23 test for destination extraction with dynamic ID
  it('extracts dynamic HubCloud destination URL accurately', () => {
    const targetUrl = 'https://hubcloud.ist/drive/ifyf3iimeyhfvl1';
    const snapshot: PageSnapshot = {
      url: 'https://mediator.biz/final',
      status: 200,
      html: `
        <html>
        <body>
          <div class="download-section">
            <a class="btn-download" href="${targetUrl}">Download File</a>
          </div>
        </body>
        </html>
      `,
      timestamp: Date.now(),
    };

    const result = detectPage(snapshot);
    expect(result.state).toBe(LinkState.DESTINATION_FOUND);
    if (result.state === LinkState.DESTINATION_FOUND) {
      expect(result.destination).toBe(targetUrl);
    }

    // Direct helper extraction
    expect(extractHubCloudUrl(snapshot.html)).toBe(targetUrl);

    // Another dynamic ID
    const dynamicId = 'custom_id_98765xyz';
    const dynamicHtml = `<div><a href="https://hubcloud.ist/drive/${dynamicId}">Link</a></div>`;
    expect(extractHubCloudUrl(dynamicHtml)).toBe(`https://hubcloud.ist/drive/${dynamicId}`);
  });

  // Test 7: Unknown page -> ERROR
  it('returns ERROR for unrecognized or empty page content', () => {
    const snapshot: PageSnapshot = {
      url: 'https://random-unknown-site.org/',
      status: 200,
      html: '<html><body>Welcome to an unrelated personal blog. Hello world!</body></html>',
      timestamp: Date.now(),
    };

    const result = detectPage(snapshot);
    expect(result.state).toBe(LinkState.ERROR);
    expect(result.reason).toBe('Unable to identify page state');
  });

  // Test 8: Valid transition accepted
  it('accepts valid state transitions according to ALLOWED_TRANSITIONS', () => {
    const machine = new LinkStateMachine('https://example.com/start');
    expect(machine.getState()).toBe(LinkState.START);

    // START -> FETCH_PAGE
    machine.transition(LinkState.FETCH_PAGE, 'Fetching page');
    expect(machine.getState()).toBe(LinkState.FETCH_PAGE);

    // FETCH_PAGE -> MEDIATOR
    machine.transition(LinkState.MEDIATOR, 'Found mediator');
    expect(machine.getState()).toBe(LinkState.MEDIATOR);

    // MEDIATOR -> WAITING
    machine.transition(LinkState.WAITING, 'Waiting for timer');
    expect(machine.getState()).toBe(LinkState.WAITING);

    // WAITING -> DESTINATION_FOUND
    machine.transition(LinkState.DESTINATION_FOUND, 'Found HubCloud link');
    expect(machine.getState()).toBe(LinkState.DESTINATION_FOUND);

    // DESTINATION_FOUND -> SUCCESS
    machine.transition(LinkState.SUCCESS, 'Destination validated');
    expect(machine.getState()).toBe(LinkState.SUCCESS);
    expect(machine.isTerminal()).toBe(true);

    const history = machine.getContext().history;
    expect(history.length).toBe(5);
    expect(history[0].from).toBe(LinkState.START);
    expect(history[0].to).toBe(LinkState.FETCH_PAGE);
  });

  // Test 9: Invalid transition rejected
  it('rejects invalid state transitions by throwing descriptive errors', () => {
    const machine = new LinkStateMachine('https://example.com/start');
    
    // Direct START -> SUCCESS is not allowed
    expect(() => {
      machine.transition(LinkState.SUCCESS, 'Jumping to success');
    }).toThrow('Invalid transition: START → SUCCESS');

    // Terminal states cannot transition
    expect(() => {
      assertTransition(LinkState.SUCCESS, LinkState.FETCH_PAGE);
    }).toThrow('Invalid transition: SUCCESS → FETCH_PAGE');

    expect(() => {
      assertTransition(LinkState.CHALLENGE_REQUIRED, LinkState.SUCCESS);
    }).toThrow('Invalid transition: CHALLENGE_REQUIRED → SUCCESS');
  });

  // Test 10: Timeout detected
  it('detects overall timeout and transitions to TIMEOUT', () => {
    const machine = new LinkStateMachine('https://example.com/start', {
      timeoutMs: 50, // 50ms timeout
    });

    machine.transition(LinkState.FETCH_PAGE, 'Starting');

    // Simulate passage of time
    const futureTime = Date.now() + 100;
    vi.spyOn(Date, 'now').mockReturnValue(futureTime);

    const snapshot: PageSnapshot = {
      url: 'https://example.com/step',
      status: 200,
      html: '<div>Please wait</div>',
      timestamp: futureTime,
    };

    const result = machine.processPage(snapshot);
    expect(machine.getState()).toBe(LinkState.TIMEOUT);
    expect(result.state).toBe(LinkState.ERROR);
    expect(result.reason).toContain('timeout exceeded');

    vi.restoreAllMocks();
  });

  // Test 11: Retry limit enforced
  it('enforces retry limits and marks ERROR when maxAttempts is exceeded', () => {
    const machine = new LinkStateMachine('https://example.com/start', {
      maxAttempts: 1,
    });

    expect(machine.canRetry()).toBe(true);

    // Process a page snapshot to register an attempt
    machine.processPage({
      url: 'https://example.com/step',
      status: 200,
      html: '<div>Unknown page content</div>',
      timestamp: Date.now(),
    });

    expect(machine.getContext().attempts).toBe(1);
    expect(machine.canRetry()).toBe(false);

    machine.retry(); // Exceeded -> ERROR
    expect(machine.getState()).toBe(LinkState.ERROR);
    expect(machine.getContext().error).toBe('Maximum retry attempts exceeded');
  });

  // Test 12: Successful destination -> SUCCESS
  it('processes full successful link lifecycle to SUCCESS', () => {
    const targetDestination = 'https://hubcloud.ist/drive/ifyf3iimeyhfvl1';
    const onStateChange = vi.fn();
    const onDestination = vi.fn();

    const machine = new LinkStateMachine('https://example.com/start', {
      onStateChange,
      onDestination,
    });

    const snapshot: PageSnapshot = {
      url: 'https://latestnewsonline.sbs/r/test',
      status: 200,
      html: `
        <div>
          <h2>Get Link Page</h2>
          <a href="${targetDestination}">Download Link</a>
        </div>
      `,
      timestamp: Date.now(),
    };

    const result = machine.processPage(snapshot);
    expect(result.state).toBe(LinkState.DESTINATION_FOUND);
    expect(machine.getState()).toBe(LinkState.DESTINATION_FOUND);
    expect(machine.getContext().destination).toBe(targetDestination);
    expect(onDestination).toHaveBeenCalledWith(targetDestination, expect.anything());

    // Mark success
    machine.markSuccess();
    expect(machine.getState()).toBe(LinkState.SUCCESS);

    const summary = machine.getResult();
    expect(summary.success).toBe(true);
    expect(summary.destination).toBe(targetDestination);
    expect(summary.state).toBe(LinkState.SUCCESS);
    expect(summary.history.length).toBeGreaterThan(0);
  });

  // Test 13: Countdown extractor unit test
  it('accurately parses various countdown formats into milliseconds', () => {
    expect(extractCountdown('Please wait 5 seconds...')).toBe(5000);
    expect(extractCountdown('countdown: 12 sec')).toBe(12000);
    expect(extractCountdown('Wait 30s')).toBe(30000);
    expect(extractCountdown('No countdown here')).toBeNull();
  });

  // Test 14: Worker integration test with processLink
  it('worker processes link successfully and returns destination', async () => {
    const dest = 'https://hubcloud.ist/drive/worker_dest_123';
    const mockFetcher = async (url: string): Promise<PageSnapshot> => ({
      url,
      status: 200,
      html: `<div><a href="${dest}">Link</a></div>`,
      timestamp: Date.now(),
    });

    const resolved = await processLink('https://mediator.biz/item', {
      fetcher: mockFetcher,
    });

    expect(resolved).toBe(dest);
  });

  // Test 15: Worker throws on Cloudflare challenge without attempting bypass
  it('worker throws clear error on CHALLENGE_REQUIRED', async () => {
    const mockFetcher = async (url: string): Promise<PageSnapshot> => ({
      url,
      status: 403,
      html: '<title>Just a moment...</title><p>Checking if the site connection is secure</p>',
      timestamp: Date.now(),
    });

    await expect(processLink('https://mediator.biz/cf', { fetcher: mockFetcher }))
      .rejects.toThrow('Verification required; manual/authorized browser flow needed');
  });
});
