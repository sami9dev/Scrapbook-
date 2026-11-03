import { config } from '../config/config.js';

/**
 * Bounded concurrency utilities for parallel mediator resolution.
 *
 * Provides:
 *  - Semaphore:           classic counting semaphore for limiting concurrent async operations
 *  - runBounded():        run a list of tasks with bounded concurrency, collect results in input order
 *  - runBoundedWith():    same but shares a Playwright Browser across all workers
 *
 * Design constraints:
 *  - Concurrency limit is configurable (MEDIATOR_CONCURRENCY env var, default 8)
 *  - One error in one task does NOT abort other tasks (error isolation)
 *  - Results are returned in the same order as input tasks
 *  - No shared cookies, auth, or session state between contexts
 */

/**
 * Simple counting semaphore.
 * Limits the number of concurrent async operations.
 */
export class Semaphore {
  /**
   * @param {number} limit  Maximum number of concurrent permits
   */
  constructor(limit) {
    this._limit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
    this._active = 0;
    this._queue = [];
  }

  /**
   * Acquire a permit. Resolves immediately if under the limit,
   * otherwise queues until a permit is released.
   * @param {AbortSignal} [signal]  Abort queued acquisition if the caller disconnects
   * @returns {Promise<() => void>}  A release function — call it when done
   */
  acquire(signal) {
    return new Promise((resolve, reject) => {
      const ticket = {
        queued: false,
        settled: false,
        grant: null,
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const rejectAborted = () => {
        if (ticket.settled) return;
        ticket.settled = true;
        if (ticket.queued) {
          const index = this._queue.indexOf(ticket);
          if (index !== -1) this._queue.splice(index, 1);
          ticket.queued = false;
        }
        cleanup();
        reject(signal?.reason || new Error('Semaphore acquisition aborted'));
      };
      const onAbort = () => rejectAborted();

      ticket.grant = () => {
        if (ticket.settled) return false;
        if (signal?.aborted) {
          rejectAborted();
          return false;
        }
        if (this._active < this._limit) {
          ticket.settled = true;
          this._active++;
          cleanup();
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this._release();
          });
          return true;
        } else {
          if (!ticket.queued) {
            ticket.queued = true;
            this._queue.push(ticket);
          }
          return false;
        }
      };

      if (signal?.aborted) {
        rejectAborted();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      ticket.grant();
    });
  }

  _release() {
    this._active = Math.max(0, this._active - 1);
    while (this._queue.length > 0) {
      const next = this._queue.shift();
      next.queued = false;
      if (next.grant()) break;
    }
  }

  get active() { return this._active; }
  get queued() { return this._queue.length; }
  get limit()  { return this._limit; }
}

// One process-wide budget shared by Telegram resolution, API routes and
// background browser batches. This prevents concurrent jobs from each
// launching their own Chromium instance on small Render plans.
export const mediatorResolutionSemaphore = new Semaphore(config.mediatorConcurrency);

/**
 * Runs an array of async task factories with bounded concurrency.
 * Results are returned in the same order as the input array.
 * Errors from individual tasks are caught and returned as Error objects
 * so one failure does not abort the batch.
 *
 * @template T
 * @param {Array<() => Promise<T>>}  tasks      Array of zero-argument async functions
 * @param {number}                   limit      Maximum concurrent tasks
 * @returns {Promise<Array<T | Error>>}         Results in input order; failed slots contain Error instances
 */
export async function runBounded(tasks, limit) {
  const semaphore = new Semaphore(limit);
  const results = new Array(tasks.length);

  await Promise.all(
    tasks.map(async (task, index) => {
      const release = await semaphore.acquire();
      try {
        results[index] = await task();
      } catch (err) {
        results[index] = err instanceof Error ? err : new Error(String(err));
      } finally {
        release();
      }
    })
  );

  return results;
}

/**
 * Runs mediator-resolution tasks with bounded concurrency while sharing
 * a single Playwright Browser instance across all concurrent workers.
 *
 * Each worker gets its own isolated BrowserContext so there is no shared
 * cookie/session state between independent link resolutions.
 *
 * The browser is launched before the first task and closed (if owned) after
 * all tasks finish. If an existing browser is provided it is NOT closed here.
 *
 * @param {Array<(browser: import('playwright').Browser) => Promise<T>>} tasks
 * @param {number}   limit             Max concurrent workers
 * @param {object}   [options]
 * @param {boolean}  [options.headless]         Passed to chromium.launch()
 * @param {import('playwright').Browser} [options.existingBrowser]  Reuse an existing browser
 * @param {AbortSignal} [options.signal]        Cancels waiting for the process-wide permit
 * @returns {Promise<{ results: Array<T | Error>, timings: object }>}
 */
export async function runBoundedWithBrowser(tasks, limit, options = {}) {
  if (tasks.length === 0) {
    return { results: [], timings: { browserStartMs: 0, totalMs: 0 } };
  }

  const headless = options.headless !== undefined ? options.headless : true;
  const totalStart = Date.now();
  let browser = options.existingBrowser || null;
  let ownBrowser = false;
  let browserStartMs = 0;
  const releaseGlobal = await mediatorResolutionSemaphore.acquire(options.signal);

  try {
    const { chromium } = await import('playwright');
    if (!browser) {
      const launchStart = Date.now();
      browser = await chromium.launch({
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      browserStartMs = Date.now() - launchStart;
      ownBrowser = true; // we launched it, we close it in finally
    }

    const semaphore = new Semaphore(limit);
    const results = new Array(tasks.length);

    await Promise.all(
      tasks.map(async (task, index) => {
        const release = await semaphore.acquire();
        try {
          results[index] = await task(browser);
        } catch (err) {
          results[index] = err instanceof Error ? err : new Error(String(err));
        } finally {
          release();
        }
      })
    );

    return {
      results,
      timings: {
        browserStartMs,
        totalMs: Date.now() - totalStart,
      },
    };
  } finally {
    if (ownBrowser && browser) {
      await browser.close().catch(() => {});
    }
    releaseGlobal();
  }
}
