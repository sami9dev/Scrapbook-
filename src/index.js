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
    });

    // 4. Initialize Telegram Bot if token provided
    let telegramBot = null;
    if (process.env.TELEGRAM_BOT_TOKEN) {
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

    // Handle graceful shutdown
    const shutdown = async () => {
      logger.warning('Shutting down scraper server...');
      if (telegramBot) telegramBot.stopPolling();
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
