process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config/config.js';
import { logger } from './logging/logger.js';
import { dbManager } from './database/mongodb.js';
import { scrapedLinksRepo, jobsRepo } from './database/models.js';
import apiRoutes from './api/routes.js';

// Pre-load providers
import './providers/gdflix.js';
import './providers/vcloud.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createApp() {
  const app = express();

  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));

  // Static Admin UI
  const publicDir = path.resolve(__dirname, 'public');
  app.use(express.static(publicDir));

  // REST API Routes
  app.use('/api', apiRoutes);

  // Health check for Render / UptimeRobot keep-alive
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
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

    // 3. Listen on port
    const server = app.listen(config.port, () => {
      logger.database(`Server listening on http://localhost:${config.port}`);
      logger.database(`Admin dashboard available at http://localhost:${config.port}/`);

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
    });

    // 4. Initialize Telegram Bot if token provided
    let telegramBot = null;
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

    // 5. Initialize High-Speed Go Telegram Bot daemon
    let goBotProcess = null;
    if (process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const { spawn } = await import('node:child_process');
        const fsModule = await import('node:fs');

        const candidatePaths = [
          path.resolve(__dirname, '..', 'go-telegram-bot', process.platform === 'win32' ? 'bot.exe' : 'bot-linux'),
          path.resolve(__dirname, '..', 'go-telegram-bot', 'bot'),
          path.resolve(__dirname, '..', 'go-telegram-bot', 'bot-linux'),
          path.resolve(__dirname, '..', 'go-telegram-bot', 'bot.exe'),
          '/app/go-telegram-bot/bot',
        ];

        let botBin = null;
        for (const cp of candidatePaths) {
          if (fsModule.existsSync(cp)) {
            botBin = cp;
            break;
          }
        }

        if (botBin) {
          if (process.platform !== 'win32') {
            try { fsModule.chmodSync(botBin, 0o755); } catch (_) {}
          }
          const botDir = path.dirname(botBin);
          const env = {
            ...process.env,
            LOCAL_RESOLVER_API: `http://127.0.0.1:${config.port}/api/resolve-link`,
            RESOLVER_LOCAL_API: `http://127.0.0.1:${config.port}/api/resolve-link`,
            WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY || '2',
            PORT: String(config.port),
          };
          logger.database(`Spawning Go Telegram Bot from: ${botBin}`);
          goBotProcess = spawn(botBin, [], {
            cwd: botDir,
            env,
            stdio: 'inherit',
          });
          goBotProcess.on('error', (err) => {
            logger.error(`Go Telegram Bot process error: ${err.message}`);
          });
          goBotProcess.on('exit', (code, signal) => {
            logger.warning(`Go Telegram Bot exited with code ${code} signal ${signal}`);
          });
        } else {
          logger.warning('No Go bot binary found (bot-linux/bot.exe).');
        }
      } catch (goErr) {
        logger.error(`Error spawning Go Telegram Bot: ${goErr.message}`);
      }
    }

    // Handle graceful shutdown
    const shutdown = async () => {
      logger.warning('Shutting down scraper server...');
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
