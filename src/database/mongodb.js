import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { config } from '../config/config.js';
import { logger } from '../logging/logger.js';

/**
 * In-memory collection emulator for tests or offline operation.
 */
class InMemoryCollection {
  constructor(name) {
    this.name = name;
    this.documents = [];
    this.indexes = [];
    this.storageFile = path.resolve(process.cwd(), 'data', 'in_memory_' + name + '.json');
    try {
      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, 'utf8');
        this.documents = JSON.parse(raw);
      }
    } catch (e) {}
  }

  _save() {
    try {
      const dir = path.dirname(this.storageFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storageFile, JSON.stringify(this.documents, null, 2), 'utf8');
    } catch (e) {}
  }

  async createIndex(keys, options = {}) {
    this.indexes.push({ keys, options });
    return Object.keys(keys).join('_');
  }

  async insertOne(doc) {
    // Check unique indexes
    for (const idx of this.indexes) {
      if (idx.options && idx.options.unique) {
        const conflict = this.documents.find((existing) => {
          return Object.keys(idx.keys).every((field) => {
            return existing[field] !== undefined && existing[field] === doc[field];
          });
        });

        if (conflict) {
          const err = new Error(`E11000 duplicate key error collection: ${this.name}`);
          err.code = 11000;
          throw err;
        }
      }
    }

    const newDoc = {
      _id: doc._id || Math.random().toString(36).substring(2, 15),
      ...doc,
      createdAt: doc.createdAt || new Date(),
      updatedAt: doc.updatedAt || new Date(),
    };
    this.documents.push(newDoc);
    this._save();
    return { acknowledged: true, insertedId: newDoc._id };
  }

  async findOne(query = {}) {
    return this.documents.find((doc) => {
      return Object.entries(query).every(([k, v]) => doc[k] === v);
    }) || null;
  }

  find(query = {}) {
    let docs = this.documents.filter((doc) => {
      return Object.entries(query).every(([k, v]) => {
        if (v && typeof v === 'object') {
          if (v.$in !== undefined && Array.isArray(v.$in)) {
            return v.$in.includes(doc[k]);
          }
          if (v.$ne !== undefined) {
            return doc[k] !== v.$ne;
          }
          if (v.$regex !== undefined) {
            const re = v.$regex instanceof RegExp ? v.$regex : new RegExp(v.$regex, v.$options || 'i');
            return re.test(doc[k] || '');
          }
        }
        return doc[k] === v;
      });
    });

    return {
      sort: (sortObj = {}) => {
        const [field, direction] = Object.entries(sortObj)[0] || ['_id', 1];
        docs.sort((a, b) => {
          if (a[field] < b[field]) return direction === 1 ? -1 : 1;
          if (a[field] > b[field]) return direction === 1 ? 1 : -1;
          return 0;
        });
        return {
          toArray: async () => [...docs],
          limit: (n) => ({
            toArray: async () => docs.slice(0, n),
          }),
        };
      },
      toArray: async () => [...docs],
      limit: (n) => ({
        toArray: async () => docs.slice(0, n),
      }),
    };
  }

  async updateOne(filter, update, options = {}) {
    const doc = await this.findOne(filter);
    if (!doc) {
      if (options.upsert) {
        const insertData = { ...filter, ...(update.$set || update) };
        return await this.insertOne(insertData);
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }

    if (update.$set) {
      Object.assign(doc, update.$set, { updatedAt: new Date() });
    }
    this._save();
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async countDocuments(query = {}) {
    const res = await this.find(query).toArray();
    return res.length;
  }

  async deleteMany(query = {}) {
    const prev = this.documents.length;
    this.documents = this.documents.filter((doc) => {
      return !Object.entries(query).every(([k, v]) => doc[k] === v);
    });
    this._save();
    return { deletedCount: prev - this.documents.length };
  }
}

/**
 * In-memory database emulator.
 */
class InMemoryDb {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new InMemoryCollection(name));
    }
    return this.collections.get(name);
  }
}

class DatabaseManager {
  constructor() {
    this.client = null;
    this.db = null;
    this.isInMemory = false;
  }

  /**
   * Connects to MongoDB, or falls back to in-memory mode if unavailable or in test mode.
   * @param {string} [uri]
   * @param {object} [options]
   */
  async connect(uri = config.mongodbUri, options = {}) {
    if (this.db) return this.db;

    if (options.forceInMemory) {
      logger.database('Initializing in-memory database storage (forced).');
      this.db = new InMemoryDb();
      this.isInMemory = true;
      return this.db;
    }

    try {
      this.client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 2000,
        connectTimeoutMS: 2000,
        ...options,
      });

      await this.client.connect();
      this.db = this.client.db();
      this.isInMemory = false;
      logger.database(`Connected to MongoDB at ${uri.replace(/\/\/.*@/, '//***@')}`);
      return this.db;
    } catch (err) {
      logger.warning(`Could not connect to MongoDB daemon (${err.message}). Falling back to In-Memory repository.`);
      this.db = new InMemoryDb();
      this.isInMemory = true;
      return this.db;
    }
  }

  /**
   * Returns a collection reference.
   * @param {string} name
   */
  getCollection(name) {
    if (!this.db) {
      throw new Error('Database not initialized. Call connect() first.');
    }
    return this.db.collection(name);
  }

  /**
   * Disconnects database client.
   */
  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.db = null;
    this.isInMemory = false;
  }
}

export const dbManager = new DatabaseManager();
export default dbManager;
