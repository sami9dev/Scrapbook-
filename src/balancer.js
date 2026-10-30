import http from 'node:http';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const BALANCER_PORT = parseInt(process.env.BALANCER_PORT || '3000', 10);
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// 3 Independent Scraper Worker Instances for 3x throughput
const INSTANCES = [
  { id: 1, host: '127.0.0.1', port: 3001, url: 'http://127.0.0.1:3001', healthy: true, active: 0, total: 0 },
  { id: 2, host: '127.0.0.1', port: 3002, url: 'http://127.0.0.1:3002', healthy: true, active: 0, total: 0 },
  { id: 3, host: '127.0.0.1', port: 3003, url: 'http://127.0.0.1:3003', healthy: true, active: 0, total: 0 },
];

let roundRobinCounter = 0;

/**
 * Least-Connections + Round-Robin Load Balancer Algorithm
 */
function pickTargetInstance() {
  const healthy = INSTANCES.filter((i) => i.healthy);
  const pool = healthy.length > 0 ? healthy : INSTANCES;

  // Find lowest active requests
  let minActive = pool[0].active;
  for (const inst of pool) {
    if (inst.active < minActive) minActive = inst.active;
  }

  // Filter instances tied for lowest active requests
  const candidates = pool.filter((i) => i.active === minActive);
  roundRobinCounter = (roundRobinCounter + 1) % candidates.length;
  return candidates[roundRobinCounter];
}

/**
 * Priority 1: Check Upstash BEFORE scraping or resolving
 */
async function checkUpstashLink(mediatorUrl) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN || !mediatorUrl) return null;
  try {
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(mediatorUrl.trim()).digest('hex');
    const res = await fetch(`${UPSTASH_URL}/get/cinefuel:cache:link:${hash}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.result && typeof data.result === 'string') {
        return data.result;
      }
    }
  } catch {}
  return null;
}

/**
 * Save resolved HubCloud link to Upstash (7 days TTL)
 */
async function saveUpstashLink(mediatorUrl, destination) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN || !mediatorUrl || !destination) return;
  try {
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(mediatorUrl.trim()).digest('hex');
    await fetch(`${UPSTASH_URL}/set/cinefuel:cache:link:${hash}?ex=604800`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(destination),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

/**
 * Health check loop for all instances every 5s
 */
function startHealthChecks() {
  setInterval(async () => {
    for (const inst of INSTANCES) {
      try {
        const res = await fetch(`${inst.url}/health`, { signal: AbortSignal.timeout(2500) });
        inst.healthy = res.ok;
      } catch {
        inst.healthy = false;
      }
    }
  }, 5000);
}

export function startBalancer() {
  const server = http.createServer(async (req, res) => {
    // 1. Balancer Stats / Health Endpoint
    if (req.url === '/balancer/stats' || req.url === '/balancer/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          instances: INSTANCES.map((i) => ({
            id: i.id,
            port: i.port,
            healthy: i.healthy,
            activeRequests: i.active,
            totalRequests: i.total,
          })),
        })
      );
    }

    // 2. Priority 1 Check for Link Resolving: check Upstash BEFORE dispatching to scraper
    if (req.method === 'POST' && req.url === '/api/resolve-link') {
      let bodyData = '';
      req.on('data', (chunk) => {
        bodyData += chunk;
      });
      req.on('end', async () => {
        let parsed = null;
        try {
          parsed = JSON.parse(bodyData);
        } catch {}

        const targetUrl = parsed?.mediatorUrl || parsed?.url;
        if (targetUrl) {
          const cachedDestination = await checkUpstashLink(targetUrl);
          if (cachedDestination) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(
              JSON.stringify({
                success: true,
                destination: cachedDestination,
                fromCache: true,
                source: 'upstash',
              })
            );
          }
        }

        // Forward to least-busy scraper instance
        proxyRequest(req, res, bodyData);
      });
      return;
    }

    // Default Proxy for all other requests
    proxyRequest(req, res, null);
  });

  function proxyRequest(req, res, bufferedBody) {
    const target = pickTargetInstance();
    target.active++;
    target.total++;

    const options = {
      hostname: target.host,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        'x-forwarded-for': req.socket.remoteAddress,
        'x-balancer-instance': target.id.toString(),
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      // Capture response if it's resolve-link to cache in Upstash
      let respBody = '';
      const isResolveLink = req.url === '/api/resolve-link';

      res.writeHead(proxyRes.statusCode, proxyRes.headers);

      proxyRes.on('data', (chunk) => {
        if (isResolveLink) respBody += chunk;
        res.write(chunk);
      });

      proxyRes.on('end', () => {
        target.active = Math.max(0, target.active - 1);
        res.end();

        if (isResolveLink && respBody) {
          try {
            const data = JSON.parse(respBody);
            if (data?.success && data?.destination) {
              const medUrl = bufferedBody ? JSON.parse(bufferedBody)?.mediatorUrl : null;
              if (medUrl) saveUpstashLink(medUrl, data.destination);
            }
          } catch {}
        }
      });
    });

    proxyReq.on('error', (err) => {
      target.active = Math.max(0, target.active - 1);
      target.healthy = false;
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Bad Gateway: scraper instance on port ${target.port} failed`, details: err.message }));
      }
    });

    if (bufferedBody) {
      proxyReq.write(bufferedBody);
      proxyReq.end();
    } else {
      req.pipe(proxyReq);
    }
  }

  server.listen(BALANCER_PORT, () => {
    console.log(`[Load Balancer] Listening on port ${BALANCER_PORT} -> Distributing to ports 3001, 3002, 3003`);
  });

  startHealthChecks();
  return server;
}

if (process.argv[1] && process.argv[1].endsWith('balancer.js')) {
  startBalancer();
}
