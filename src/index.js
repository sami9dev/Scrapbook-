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

    // Handle graceful shutdown
    const shutdown = async () => {
      logger.warning('Shutting down scraper server...');
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
