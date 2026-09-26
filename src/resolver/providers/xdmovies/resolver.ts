import type { Page } from 'playwright';
import type { ProviderLink, ResolveResult, ResolverContext } from '../../types.js';
import { ResolverStateMachine } from '../../state-machine.js';
import { browserManager } from '../../browser-manager.js';
import { detectDestination } from '../../destination-detector.js';
import { resolverLogger as log } from '../../logging/logger.js';
import { DEFAULT_TIMEOUTS } from '../../types.js';
import { MEDIATOR_FLOW, CHALLENGE_SELECTORS, CHALLENGE_TEXT_PATTERNS } from './selectors.js';

async function isChallengePage(page: Page): Promise<boolean> {
  return page.evaluate(
    ({selectors, patterns}: {selectors: string[]; patterns: string[]}) => {
      for (const sel of selectors) { const el = document.querySelector(sel); if (el && (el as HTMLElement).offsetParent !== null) return true; }
      const text = (document.body?.innerText ?? '').slice(0, 3000).toLowerCase();
      const title = document.title.toLowerCase();
      return patterns.some(p => text.includes(p) || title.includes(p));
    },
    { selectors: CHALLENGE_SELECTORS as unknown as string[], patterns: CHALLENGE_TEXT_PATTERNS.map(r=>r.source.replace(/\\b|\\s\*/g,' ').toLowerCase()) },
  );
}

async function clickButtonByText(page: Page, pattern: RegExp, timeoutMs: number): Promise<boolean> {
  try {
    const btn = page.getByRole('button', {name: pattern}).or(page.locator('a,button,[role="button"]').filter({hasText: pattern}));
    await btn.first().waitFor({state:'visible', timeout: timeoutMs});
    await btn.first().click();
    return true;
  } catch { return false; }
}

async function waitForPageState(page: Page, patterns: Record<string, RegExp>, timeoutMs: number): Promise<string|null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 5000));
    for (const [key, pat] of Object.entries(patterns)) { if (pat.test(text)) return key; }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

export async function resolveXDMoviesLink(link: ProviderLink, context: ResolverContext): Promise<ResolveResult> {
  const sm = new ResolverStateMachine('INITIAL' as any);
  const sessionId = context.sessionId;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(context.options.timeouts ?? {}) };
  const startTime = Date.now();
  let detectedDestUrl: string|null = null;

  await browserManager.createContext(sessionId, { headless: context.options.headless ?? true });
  const page = await browserManager.newPage(sessionId);

  page.on('framenavigated', frame => { if (frame === page.mainFrame()) { const u = frame.url(); if (detectDestination(u)) detectedDestUrl = u; } });
  page.on('response', resp => { const u = resp.url(); if (detectDestination(u)) detectedDestUrl = u; });

  function fail(code: string, message: string): ResolveResult {
    sm.transition(code as any);
    browserManager.closeContext(sessionId).catch(()=>{});
    return { success:false, sessionId, provider:'xdmovies', state:code as any, errorCode:code as any, error:message, completedAt:new Date().toISOString(), elapsedMs:Date.now()-startTime, history:[...sm.history] };
  }

  try {
    sm.transition('SOURCE_DETECTED' as any);
    sm.transition('INTERMEDIARY' as any);
    log.resolver(sessionId, 'xdmovies', 'INTERMEDIARY' as any);

    await page.goto(link.redirectUrl, { waitUntil:'domcontentloaded', timeout: timeouts.pageLoad });

    if (detectedDestUrl || detectDestination(page.url())) {
      const dest = detectDestination(detectedDestUrl ?? page.url())!;
      sm.transition('COMPLETE' as any);
      await browserManager.closeContext(sessionId);
      return { success:true, sessionId, provider:'xdmovies', state:'COMPLETE' as any, destination:dest, completedAt:new Date().toISOString(), elapsedMs:Date.now()-startTime, history:[...sm.history] };
    }

    sm.transition('WAITING' as any, 'Mediator loaded');
    const clickedGenerate = await clickButtonByText(page, MEDIATOR_FLOW.GENERATE_LINK, timeouts.selector);
    if (!clickedGenerate) return fail('PARSER_FAILED', 'Could not find Generate Link button');

    sm.transition('WAITING' as any, 'Step 1 countdown');
    const afterStep1 = await waitForPageState(page, { STEP_1_DONE: MEDIATOR_FLOW.STEP_1_DONE, CAPTCHA: /captcha|challenge/i }, timeouts.resolver);
    if (!afterStep1) return fail('TIMEOUT', 'Timed out waiting for Step 1');

    sm.transition('LINK_READY' as any);
    const clickedContinue = await clickButtonByText(page, MEDIATOR_FLOW.STEP_1_DONE, timeouts.selector);
    if (!clickedContinue) return fail('PARSER_FAILED', 'Could not find Continue to Step 2 button');

    sm.transition('WAITING' as any, 'Step 2 countdown');
    const afterStep2 = await waitForPageState(page, { STEP_2_DONE: MEDIATOR_FLOW.CAPTCHA_SUCCESS, CAPTCHA_REQUIRED: /complete.*captcha|turnstile/i }, timeouts.resolver);
    if (!afterStep2) return fail('TIMEOUT', 'Timed out waiting for Step 2');

    const hasCaptcha = await isChallengePage(page);
    if (hasCaptcha) {
      sm.transition('HUMAN_ACTION_REQUIRED' as any);
      log.resolver(sessionId, 'xdmovies', 'HUMAN_ACTION_REQUIRED' as any);
      if (!context.options.waitForCaptcha) {
        return { success:false, sessionId, provider:'xdmovies', state:'HUMAN_ACTION_REQUIRED' as any, humanActionRequired:true, error:'Human verification required. Call /continue after solving.', completedAt:new Date().toISOString(), elapsedMs:Date.now()-startTime, history:[...sm.history] };
      }
      const captchaTimeout = context.options.captchaTimeoutMs ?? 60_000;
      const solved = await waitForPageState(page, { SOLVED: MEDIATOR_FLOW.CAPTCHA_SUCCESS }, captchaTimeout);
      if (!solved) return fail('TIMEOUT', 'CAPTCHA not solved within timeout');
    }

    sm.transition('DESTINATION_NAVIGATION' as any);
    const clickedGo = await clickButtonByText(page, MEDIATOR_FLOW.GO_TO_LINK, timeouts.selector);
    if (!clickedGo) return fail('PARSER_FAILED', 'Could not find Go to Link button');

    const deadline = Date.now() + timeouts.selector;
    while (Date.now() < deadline) {
      if (detectedDestUrl) break;
      if (detectDestination(page.url())) { detectedDestUrl = page.url(); break; }
      await new Promise(r => setTimeout(r, 300));
    }

    if (!detectedDestUrl) return fail('DESTINATION_NOT_FOUND', 'Navigation did not reach a known destination');
    const dest = detectDestination(detectedDestUrl);
    if (!dest) return fail('UNSUPPORTED_DESTINATION', `Unknown destination: ${detectedDestUrl}`);

    sm.transition('DESTINATION_DETECTED' as any);
    sm.transition('COMPLETE' as any);
    log.resolver(sessionId, 'xdmovies', 'COMPLETE' as any);
    return { success:true, sessionId, provider:'xdmovies', state:'COMPLETE' as any, destination:dest, completedAt:new Date().toISOString(), elapsedMs:Date.now()-startTime, history:[...sm.history] };
  } catch (err) {
    return fail('NETWORK_ERROR', (err as Error).message);
  } finally {
    await browserManager.closeContext(sessionId);
  }
}
