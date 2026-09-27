import http from 'http';
import { runBoundedWithBrowser } from '../src/utils/concurrency.js';
import { resolveMediatorFlow } from '../src/resolvers/mediator/browser.js';
import { isHubCloudDriveUrl } from '../src/providers/hubcloud/validator.js';

// Setup local mock server with simulated realistic mediator countdown (1.5s per link)
// to measure concurrency scaling without external network rate-limiting or anti-bot interference.
function startMockServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Fast Mediator Test</title></head>
        <body>
          <div id="countdown-wrapper"><span id="timer">1</span> seconds</div>
          <div id="link-container" style="display: none;">
            <a id="getLinkBtn" href="https://hubcloud.ist/drive/bench_${Date.now()}">Get Link</a>
          </div>
          <script>
            setTimeout(() => {
              document.getElementById('countdown-wrapper').style.display = 'none';
              document.getElementById('link-container').style.display = 'block';
            }, 1200);
          </script>
        </body>
        </html>
      `);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function benchmarkLevel(concurrency, count, baseUrl) {
  const startCpu = process.cpuUsage();
  const startMem = process.memoryUsage().rss;
  const wallStart = Date.now();

  const urls = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    url: `${baseUrl}/mediator-countdown?item=${i + 1}`,
  }));

  const itemTimings = [];
  let successful = 0;
  let failed = 0;

  const { results, timings: batchTimings } = await runBoundedWithBrowser(
    urls.map((item) => async (sharedBrowser) => {
      const itemStart = Date.now();
      const resolution = await resolveMediatorFlow(item.url, {
        countdownTimeout: 10000,
        navigationTimeout: 10000,
        existingBrowser: sharedBrowser,
        headless: true,
      });
      const itemElapsed = Date.now() - itemStart;
      itemTimings.push(itemElapsed);

      if (resolution.success && isHubCloudDriveUrl(resolution.destination)) {
        successful++;
      } else {
        failed++;
      }
      return resolution;
    }),
    concurrency,
    { headless: true }
  );

  const wallDurationMs = Date.now() - wallStart;
  const endCpu = process.cpuUsage(startCpu);
  const cpuMs = (endCpu.user + endCpu.system) / 1000;
  const peakMemMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);

  return {
    concurrency,
    count,
    wallDurationMs,
    wallDurationSec: (wallDurationMs / 1000).toFixed(2),
    cpuMs: cpuMs.toFixed(1),
    externalWaitEstMs: Math.max(0, wallDurationMs - cpuMs).toFixed(0),
    avgMs: (wallDurationMs / count).toFixed(1),
    p50Ms: percentile(itemTimings, 50),
    p95Ms: percentile(itemTimings, 95),
    successful,
    failed,
    peakMemMb,
    browserStartMs: batchTimings.browserStartMs,
  };
}

async function runFullBenchmark() {
  console.log('=== STARTING CONCURRENCY SCALING BENCHMARK (20 Links per test) ===');
  const { server, baseUrl } = await startMockServer();

  const levels = [1, 2, 4, 8, 12, 16];
  const results = [];

  for (const c of levels) {
    console.log(`\nRunning benchmark with Concurrency = ${c} (20 links)...`);
    // Warm-up GC
    if (global.gc) global.gc();
    const res = await benchmarkLevel(c, 20, baseUrl);
    results.push(res);
    console.log(` -> Completed Concurrency = ${c}: ${res.wallDurationSec}s | CPU: ${res.cpuMs}ms | RAM: ${res.peakMemMb}MB | Success: ${res.successful}/${res.count}`);
    // Cooldown pause
    await new Promise((r) => setTimeout(r, 1500));
  }

  server.close();

  console.log('\n================ FINAL BENCHMARK MATRIX ================');
  console.table(
    results.map((r) => ({
      Workers: r.concurrency,
      'Total Time (s)': r.wallDurationSec,
      'Speedup vs 1': `${(results[0].wallDurationMs / r.wallDurationMs).toFixed(2)}x`,
      'Local CPU (ms)': r.cpuMs,
      'P50 (ms)': r.p50Ms,
      'P95 (ms)': r.p95Ms,
      'Success Rate': `${((r.successful / r.count) * 100).toFixed(0)}%`,
      'RAM (MB)': `${r.peakMemMb} MB`,
    }))
  );

  console.log(JSON.stringify(results, null, 2));
}

runFullBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
