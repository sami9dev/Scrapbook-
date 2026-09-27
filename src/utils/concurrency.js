/**
 * Bounded concurrency utilities for parallel mediator resolution.
 *
 * Provides:
 *  - Semaphore:           classic counting semaphore for limiting concurrent async operations
 *  - runBounded():        run a list of tasks with bounded concurrency, collect results in input order
 *  - runBoundedWith():    same but shares a Playwright Browser across all workers
 *
 * Design constraints:
 *  - Concurrency limit is configurable (MEDIATOR_CONCURRENCY env var, default 4)
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
    this._limit = Math.max(1, limit);
    this._active = 0;
    this._queue = [];
  }

  /**
   * Acquire a permit. Resolves immediately if under the limit,
   * otherwise queues until a permit is released.
   * @returns {Promise<() => void>}  A release function — call it when done
   */
  acquire() {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this._active < this._limit) {
          this._active++;
          resolve(() => this._release());
        } else {
          this._queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  _release() {
    this._active--;
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    }
  }

  get active() { return this._active; }
  get queued() { return this._queue.length; }
  get limit()  { return this._limit; }
}

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
 * @returns {Promise<{ results: Array<T | Error>, timings: object }>}
 */
export async function runBoundedWithBrowser(tasks, limit, options = {}) {
  if (tasks.length === 0) {
    return { results: [], timings: { browserStartMs: 0, totalMs: 0 } };
  }

  const headless = options.headless !== undefined ? options.headless : true;
  const totalStart = Date.now();

  const { chromium } = await import('playwright');

  let browser = options.existingBrowser || null;
  let ownBrowser = false;
  let browserStartMs = 0;

  if (!browser) {
    const launchStart = Date.now();
    browser = await chromium.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    browserStartMs = Date.now() - launchStart;
    ownBrowser = true; // we launched it, we close it in finally
  }

  try {
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
  }
}
