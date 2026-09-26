import dotenv from 'dotenv';
import path from 'node:path';

// Load environment variables if .env file exists
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/scraper_db',
  
  // Scraper request controls
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '15000', 10),
  maxRedirects: parseInt(process.env.MAX_REDIRECTS || '10', 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2', 10),
  concurrency: parseInt(process.env.CONCURRENCY || '3', 10),
  backoffDelays: [1000, 2000, 4000],
  
  // Identity
  userAgent: process.env.USER_AGENT || 'AuthorizedMetadataScraper/1.0',
  
  // Authorized domain allowlist (optional: empty or '*' means allow all external valid non-private domains)
  allowedDomains: process.env.ALLOWED_DOMAINS
    ? process.env.ALLOWED_DOMAINS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
    : [],
};

export default config;
