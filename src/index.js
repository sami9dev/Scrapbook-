import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

if (process.platform !== 'win32') {
  process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';
}

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config/config.js';
import { logger } from './logging/logger.js';
import { dbManager } from './database/mongodb.js';
import { scrapedLinksRepo, jobsRepo } from './database/models.js';
import apiRoutes from './api/routes.js';



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const botState = {
  process: null,
  binPath: null,
  tokenConfigured: false,
  tokenMasked: null,
  spawnCount: 0,
  restartCount: 0,
  lastExitReason: null,
  logs: [],
  addLog(type, text) {
    const timestamp = new Date().toISOString();
    const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      this.logs.push(`[${timestamp}] [${type}] ${l}`);
      if (this.logs.length > 100) this.logs.shift();
    }
  },
};

export async function createApp() {
  const app = express();

  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));

  // CORS middleware for API access from any origin (including file:// and external frontends)
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // Static Admin UI
  const publicDir = path.resolve(__dirname, 'public');
  app.use(express.static(publicDir));

  // REST API Routes
  app.use('/api', apiRoutes);

  // Health check for Render / UptimeRobot keep-alive
  app.get('/health', (req, res) => {
    const isRunning = Boolean(botState.process && !botState.process.killed && botState.process.exitCode === null);
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      botRunning: isRunning,
      botPid: botState.process?.pid || null,
      timestamp: new Date().toISOString(),
    });
  });

  // Comprehensive bot status and log inspector
  app.get('/api/bot-status', (req, res) => {
    const isRunning = Boolean(botState.process && !botState.process.killed && botState.process.exitCode === null);
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      bot: {
        running: isRunning,
        pid: botState.process?.pid || null,
        exitCode: botState.process?.exitCode ?? null,
        signalCode: botState.process?.signalCode ?? null,
        spawnCount: botState.spawnCount,
        restartCount: botState.restartCount,
        lastExitReason: botState.lastExitReason,
        binPath: botState.binPath,
      },
      tokenConfigured: botState.tokenConfigured,
      tokenMasked: botState.tokenMasked,
      recentLogs: botState.logs.slice(-40),
      timestamp: new Date().toISOString(),
    });
  });

  // Simple Instant Solver UI
  app.get('/solver', (req, res) => {
    res.sendFile(path.join(publicDir, 'solver.html'));
  });

  // Fallback to Admin UI for root
  app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}

export async function startServer() {
  try {
    // 1. Connect to MongoDB
    await dbManager.connect();
    await scrapedLinksRepo.initIndexes();
    await jobsRepo.initIndexes();

    // 2. Create Express app
    const app = await createApp();

    // 3. Listen on port with error handling
    let isShuttingDown = false;
    let goBotProcess = null;
    let telegramBot = null;

    const server = await new Promise((resolve, reject) => {
      const srv = app.listen(config.port, () => {
        logger.database(`Server listening on http://localhost:${config.port}`);
        logger.database(`Admin dashboard available at http://localhost:${config.port}/`);
        resolve(srv);
      });

      srv.once('error', (err) => {
        reject(err);
      });
    });

    // Keep-alive pinger for Render free tier (prevents 15m idle shutdown)
    const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://scrapbook-0mrx.onrender.com';
    if (externalUrl) {
      const KEEP_ALIVE_INTERVAL = 10 * 60 * 1000; // 10 minutes
      setInterval(async () => {
        try {
          const res = await fetch(`${externalUrl}/health`);
          logger.database(`[Keep-Alive] Ping to ${externalUrl}/health -> ${res.status}`);
        } catch (e) {
          logger.warning(`[Keep-Alive] Ping failed: ${e.message}`);
        }
      }, KEEP_ALIVE_INTERVAL);
      logger.database(`[Keep-Alive] Scheduled every 10 minutes for ${externalUrl}`);
    }

    // 4. Initialize Telegram Bot if token provided
    if (process.env.ENABLE_NODE_TELEGRAM_BOT === 'true' && process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const { Telegram4KHub4UBot } = await import('./bot/telegram/index.js');
        telegramBot = new Telegram4KHub4UBot();
        app.post('/api/telegram/webhook', async (req, res) => {
          try {
            await telegramBot.handleUpdate(req.body);
            res.json({ ok: true });
          } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
          }
        });
        if (process.env.TELEGRAM_USE_WEBHOOK !== 'true') {
          telegramBot.startPolling();
        }
      } catch (botErr) {
        logger.warning(`Failed to initialize Telegram Bot: ${botErr.message}`);
      }
    }

    // 5. Initialize High-Speed Go Telegram Bot daemon (guaranteed single-instance)
    const DEFAULT_TELEGRAM_BOT_TOKEN = '8265322595:AAH1eMtGwWvIf8Wqo0dGrcZ9V5OqE-6ZpEI';
    const effectiveBotToken = (process.env.TELEGRAM_BOT_TOKEN || DEFAULT_TELEGRAM_BOT_TOKEN).trim();
    botState.tokenConfigured = Boolean(effectiveBotToken);
    botState.tokenMasked = effectiveBotToken ? `${effectiveBotToken.slice(0, 10)}...` : null;

    if (effectiveBotToken) {
      try {
        const { spawn, execSync } = await import('node:child_process');
        const fsModule = await import('node:fs');

        // Kill any existing bot process before spawning to prevent 409 Conflict
        if (process.platform === 'win32') {
          try {
            execSync('powershell -NoProfile -Command "Get-Process -Name \'bot\' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"', { stdio: 'ignore' });
          } catch (_) {}
        }

        const candidatePaths = [
          '/app/go-telegram-bot/bot',
          path.resolve(__dirname, '..', 'go-telegram-bot', 'bot'),
          path.resolve(__dirname, '..', 'go-telegram-bot', process.platform === 'win32' ? 'bot.exe' : 'bot-linux'),
          path.resolve(__dirname, '..', 'go-telegram-bot', 'bot.exe'),
        ];

        let botBin = null;
        for (const cp of candidatePaths) {
          if (fsModule.existsSync(cp)) {
            botBin = cp;
            break;
          }
        }

        botState.binPath = botBin;

        if (botBin) {
          if (process.platform !== 'win32') {
            try { fsModule.chmodSync(botBin, 0o755); } catch (_) {}
          }
          const botDir = path.dirname(botBin);
          const env = {
            ...process.env,
            TELEGRAM_BOT_TOKEN: effectiveBotToken,
            LOCAL_RESOLVER_API: `http://127.0.0.1:${config.port}/api/resolve-link`,
            RESOLVER_LOCAL_API: `http://127.0.0.1:${config.port}/api/resolve-link`,
            WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY || '1',
            PORT: String(config.port),
          };

          const spawnBot = () => {
            if (isShuttingDown) return;
            botState.spawnCount++;
            logger.database(`Spawning Go Telegram Bot from: ${botBin} (Attempt #${botState.spawnCount})`);
            botState.addLog('info', `Spawning Go Telegram Bot from ${botBin} (Attempt #${botState.spawnCount})`);

            goBotProcess = spawn(botBin, [], {
              cwd: botDir,
              env,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            botState.process = goBotProcess;

            goBotProcess.stdout.on('data', (data) => {
              const str = data.toString();
              process.stdout.write(str);
              botState.addLog('stdout', str);
            });

            goBotProcess.stderr.on('data', (data) => {
              const str = data.toString();
              process.stderr.write(str);
              botState.addLog('stderr', str);
            });

            goBotProcess.on('error', (err) => {
              logger.error(`Go Telegram Bot process error: ${err.message}`);
              botState.lastExitReason = `Process error: ${err.message}`;
              botState.addLog('error', `Process error: ${err.message}`);
            });

            goBotProcess.on('exit', (code, signal) => {
              botState.lastExitReason = `Exited code=${code} signal=${signal}`;
              logger.warning(`Go Telegram Bot exited with code ${code} signal ${signal}`);
              botState.addLog('exit', `Exited code=${code} signal=${signal}`);
              if (!isShuttingDown) {
                botState.restartCount++;
                const delayMs = Math.min(2000 * Math.pow(1.5, Math.min(botState.restartCount, 5)), 15000);
                logger.database(`Auto-restarting Go Telegram Bot in ${Math.round(delayMs / 1000)}s...`);
                botState.addLog('info', `Auto-restarting in ${Math.round(delayMs / 1000)}s...`);
                setTimeout(spawnBot, delayMs);
              }
            });
          };

          spawnBot();
        } else {
          const msg = `No Go bot binary found in candidate paths: ${candidatePaths.join(', ')}`;
          logger.warning(msg);
          botState.addLog('warning', msg);
          botState.lastExitReason = msg;
        }
      } catch (goErr) {
        logger.error(`Error spawning Go Telegram Bot: ${goErr.message}`);
        botState.addLog('error', `Error spawning: ${goErr.message}`);
      }
    }

    // Handle graceful shutdown
    const shutdown = async () => {
      logger.warning('Shutting down scraper server...');
      isShuttingDown = true;
      if (telegramBot) telegramBot.stopPolling();
      if (goBotProcess) {
        try { goBotProcess.kill('SIGTERM'); } catch (_) {}
      }
      server.close();
      await dbManager.disconnect();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return server;
  } catch (err) {
    logger.error(`Fatal server error: ${err.message}`);
    process.exit(1);
  }
}

// If executed directly
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  startServer();
}

export default createApp;
