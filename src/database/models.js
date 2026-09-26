import { dbManager } from './mongodb.js';
import { generateDedupeKey } from '../utils/dedupe.js';
import { logger } from '../logging/logger.js';

export const SCRAPED_STATUS = {
  DISCOVERED: 'DISCOVERED',
  REDIRECTING: 'REDIRECTING',
  PARSING: 'PARSING',
  RESOLVED: 'RESOLVED',
  PARTIAL: 'PARTIAL',
  HUMAN_VERIFICATION_REQUIRED: 'HUMAN_VERIFICATION_REQUIRED',
  ACCESS_DENIED: 'ACCESS_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  REDIRECT_LIMIT_EXCEEDED: 'REDIRECT_LIMIT_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR',
};

export class ScrapedLinksRepository {
  constructor() {
    this.collectionName = 'scraped_links';
  }

  get collection() {
    return dbManager.getCollection(this.collectionName);
  }

  /**
   * Initializes indexes for scraped_links.
   */
  async initIndexes() {
    const col = this.collection;
    await col.createIndex({ sourceUrl: 1 });
    await col.createIndex({ providerUrl: 1 });
    await col.createIndex({ fileId: 1 });
    await col.createIndex({ title: 1 });
    // Unique compound key to prevent duplicates
    await col.createIndex({ dedupeKey: 1 }, { unique: true });
  }

  /**
   * Saves or updates a scraped link document.
   * Prevents duplicates using dedupeKey.
   * 
   * @param {object} data
   * @returns {Promise<object>}
   */
  async saveLink(data) {
    const dedupeKey = generateDedupeKey(data);
    const now = new Date();

    const doc = {
      sourceUrl: data.sourceUrl,
      sourceDomain: data.sourceDomain || (data.sourceUrl ? new URL(data.sourceUrl).hostname : ''),
      title: data.title || null,
      year: data.year ?? null,
      type: data.type || 'tv',
      scope: data.scope || (data.episode !== null && data.episode !== undefined ? 'episode' : (data.season !== null && data.season !== undefined ? 'pack' : 'movie')),
      season: data.season ?? null,
      episode: data.episode ?? null,
      quality: data.quality || null,
      codec: data.codec || null,
      provider: data.provider || 'UNKNOWN',
      providerUrl: data.providerUrl || null,
      mediatorUrl: data.mediatorUrl || null,
      fileId: data.fileId || null,
      filename: data.filename || null,
      format: data.format || null,
      sizeBytes: data.sizeBytes ?? 0,
      sizeDisplay: data.sizeDisplay || null,
      mirrors: Array.isArray(data.mirrors) ? data.mirrors : [],
      status: data.status || SCRAPED_STATUS.RESOLVED,
      redirectChain: Array.isArray(data.redirectChain) ? data.redirectChain : [],
      sourceToken: data.sourceToken || null,
      dedupeKey,
      updatedAt: now,
    };

    try {
      const existing = await this.collection.findOne({ dedupeKey });
      if (existing) {
        await this.collection.updateOne({ dedupeKey }, { $set: doc });
        logger.database(`Updated existing record for ${dedupeKey}`);
        return { ...existing, ...doc };
      } else {
        doc.createdAt = now;
        const res = await this.collection.insertOne(doc);
        logger.database(`Saved new document with ID ${res.insertedId} for ${dedupeKey}`);
        return { _id: res.insertedId, ...doc };
      }
    } catch (err) {
      if (err.code === 11000) {
        logger.warning(`Duplicate record prevented for dedupeKey: ${dedupeKey}`);
        return await this.collection.findOne({ dedupeKey });
      }
      logger.error(`Database error saving link: ${err.message}`);
      throw err;
    }
  }

  /**
   * Finds a link by its ID.
   */
  async findById(id) {
    return await this.collection.findOne({ _id: id });
  }

  /**
   * Finds links matching a query.
   */
  async find(query = {}, options = {}) {
    let cursor = this.collection.find(query);
    if (options.sort) {
      cursor = cursor.sort(options.sort);
    }
    if (options.limit) {
      cursor = cursor.limit(options.limit);
    }
    return await cursor.toArray();
  }

  /**
   * Counts documents matching query.
   */
  async count(query = {}) {
    return await this.collection.countDocuments(query);
  }

  /**
   * Clears/deletes documents matching query (defaults to all).
   */
  async clear(query = {}) {
    return await this.collection.deleteMany(query);
  }
}

export class JobsRepository {
  constructor() {
    this.collectionName = 'scrape_jobs';
  }

  get collection() {
    return dbManager.getCollection(this.collectionName);
  }

  async initIndexes() {
    const col = this.collection;
    await col.createIndex({ status: 1 });
    await col.createIndex({ createdAt: -1 });
  }

  async createJob(urlOrObj, options = {}) {
    const now = new Date();
    const url = typeof urlOrObj === 'string' ? urlOrObj : urlOrObj?.url;
    const targetQuality =
      (typeof urlOrObj === 'object' && urlOrObj?.targetQuality)
        ? urlOrObj.targetQuality
        : (options?.targetQuality || options?.quality || 'all');

    const targetScope =
      (typeof urlOrObj === 'object' && urlOrObj?.targetScope)
        ? urlOrObj.targetScope
        : (options?.targetScope || options?.scope || 'all');

    const job = {
      _id: Math.random().toString(36).substring(2, 15),
      url,
      targetQuality,
      targetScope,
      status: SCRAPED_STATUS.DISCOVERED,
      resultsCount: 0,
      extractedLinks: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.collection.insertOne(job);
    return job;
  }

  async updateJob(id, updates) {
    const now = new Date();
    await this.collection.updateOne({ _id: id }, { $set: { ...updates, updatedAt: now } });
    return await this.collection.findOne({ _id: id });
  }

  async getJob(id) {
    return await this.collection.findOne({ _id: id });
  }

  async listJobs(query = {}, limit = 50) {
    return await this.collection.find(query).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  async getStats() {
    const total = await this.collection.countDocuments({});
    const resolved = await this.collection.countDocuments({ status: SCRAPED_STATUS.RESOLVED });
    const partial = await this.collection.countDocuments({ status: SCRAPED_STATUS.PARTIAL });
    const humanVerification = await this.collection.countDocuments({ status: SCRAPED_STATUS.HUMAN_VERIFICATION_REQUIRED });
    const errors = await this.collection.countDocuments({
      status: { $in: [SCRAPED_STATUS.ERROR, SCRAPED_STATUS.ACCESS_DENIED, SCRAPED_STATUS.TIMEOUT, SCRAPED_STATUS.REDIRECT_LIMIT_EXCEEDED] },
    });

    return {
      total,
      resolved,
      partial,
      humanVerification,
      errors,
    };
  }

  /**
   * Clears/deletes jobs matching query (defaults to all).
   */
  async clear(query = {}) {
    return await this.collection.deleteMany(query);
  }
}

export const scrapedLinksRepo = new ScrapedLinksRepository();
export const jobsRepo = new JobsRepository();

export default {
  SCRAPED_STATUS,
  scrapedLinksRepo,
  jobsRepo,
};
