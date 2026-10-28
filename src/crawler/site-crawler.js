import { fetchWithControls } from '../discovery/http-client.js';
import { logger } from '../logging/logger.js';
import { jobQueue } from '../queue/job-queue.js';
import { scrapedLinksRepo } from '../database/models.js';
import { recordInCatalog, detectPlatformFromUrl } from '../utils/catalog-store.js';
import { isXDMoviesUrl } from '../scrapers/xdmovies/types.js';
import { fetchXDMoviesPage } from '../scrapers/xdmovies/browser-fetch.js';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

export class SiteCrawler {
  constructor() {
    this.isRunning = false;
    this.isPaused = false;
    this.mode = 'range'; // 'range' | 'continuous'
    this.baseUrl = 'https://4khdhub.one';
    this.category = '';
    this.startPage = 1;
    this.endPage = 5;
    this.currentPage = 1;
    this.delayMs = 1000;
    this.totalPagesCrawled = 0;
    this.totalPostsFound = 0;
    this.seenUrls = new Set();
    this.recentPosts = [];
    this.lastError = null;
    this.crawlPromise = null;
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      mode: this.mode,
      baseUrl: this.baseUrl,
      category: this.category,
      startPage: this.startPage,
      endPage: this.endPage,
      currentPage: this.currentPage,
      delayMs: this.delayMs,
      totalPagesCrawled: this.totalPagesCrawled,
      totalPostsFound: this.totalPostsFound,
      recentPosts: this.recentPosts.slice(-10),
      lastError: this.lastError,
    };
  }

  async start(options = {}) {
    if (this.isRunning && !this.isPaused) {
      return { success: false, message: 'Crawler is already running.' };
    }

    if (this.isPaused) {
      this.isPaused = false;
      logger.discovered('Crawler resumed from pause state.');
      return { success: true, message: 'Crawler resumed.', status: this.getStatus() };
    }

    this.isRunning = true;
    this.isPaused = false;
    this.mode = options.mode || 'range';
    this.baseUrl = (options.baseUrl || this.baseUrl || 'https://4khdhub.one').replace(/\/+$/, '');
    const isXDMovies = isXDMoviesUrl(this.baseUrl);
    this.platform = options.platform || (isXDMovies ? 'XDMovies' : '4KHDHub Archive');
    this.category = options.category || '';
    this.startPage = Math.max(1, parseInt(options.startPage || 1, 10));
    this.endPage = this.mode === 'continuous' ? 9999 : Math.max(this.startPage, parseInt(options.endPage || 5, 10));
    this.currentPage = this.startPage;
    this.delayMs = Math.max(500, parseInt(options.delayMs || 1000, 10));
    this.lastError = null;

    logger.discovered(
      `Starting Site Crawler (Pages ${this.startPage} -> ${this.endPage}, Delay: ${this.delayMs}ms, Category: "${this.category || 'All'}")`
    );

    this.crawlPromise = this._runCrawlLoop();
    return { success: true, message: 'Crawler started.', status: this.getStatus() };
  }

  pause() {
    if (!this.isRunning) return { success: false, message: 'Crawler is not running.' };
    this.isPaused = true;
    logger.discovered('Crawler paused by user.');
    return { success: true, message: 'Crawler paused.', status: this.getStatus() };
  }

  resume() {
    if (!this.isRunning || !this.isPaused) return { success: false, message: 'Crawler is not paused.' };
    this.isPaused = false;
    logger.discovered('Crawler resumed.');
    return { success: true, message: 'Crawler resumed.', status: this.getStatus() };
  }

  stop() {
    if (!this.isRunning) return { success: false, message: 'Crawler is already stopped.' };
    this.isRunning = false;
    this.isPaused = false;
    logger.discovered('Crawler stopped by user.');
    return { success: true, message: 'Crawler stopped.', status: this.getStatus() };
  }

  async _runCrawlLoop() {
    try {
      while (this.isRunning && this.currentPage <= this.endPage) {
        while (this.isPaused && this.isRunning) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!this.isRunning) break;

        const pageUrl = this._buildPageUrl(this.currentPage);
        logger.discovered(`[Site Crawler] Crawling Page ${this.currentPage}: ${pageUrl}`);

        let pageHtml = '';
        try {
          const isXDMovies = isXDMoviesUrl(this.baseUrl);
          if (isXDMovies) {
            const res = await fetchXDMoviesPage(pageUrl, { headless: false, timeoutMs: 35000 });
            if (res.success && res.html) {
              pageHtml = res.html;
            } else {
              logger.warning(`[Site Crawler] Failed fetching XDMovies page ${this.currentPage}: ${res.error || 'Empty body'}`);
              this.lastError = res.error;
            }
          } else {
            const res = await fetchWithControls(pageUrl, { maxRetries: 2, timeoutMs: 12000 });
            if (res.success && res.body) {
              pageHtml = res.body;
            } else {
              logger.warning(`[Site Crawler] Failed fetching page ${this.currentPage}: ${res.error || 'Empty body'}`);
              this.lastError = res.error;
              // If page 404s, we may have reached end of site
              if (res.status === 404) {
                logger.discovered(`[Site Crawler] Reached end of pagination at page ${this.currentPage}.`);
                break;
              }
            }
          }
        } catch (fetchErr) {
          logger.error(`[Site Crawler] Network error on page ${this.currentPage}: ${fetchErr.message}`);
          this.lastError = fetchErr.message;
        }

        if (pageHtml) {
          const posts = this._extractPostsFromHtml(pageHtml, pageUrl);
          logger.discovered(`[Site Crawler] Page ${this.currentPage} yielded ${posts.length} post(s).`);

          if (posts.length === 0) {
            logger.discovered(`[Site Crawler] No more posts found at page ${this.currentPage}. Stopping.`);
            break;
          }

          for (const post of posts) {
            if (!this.isRunning) break;
            while (this.isPaused && this.isRunning) {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }

            if (!this.seenUrls.has(post.url)) {
              this.seenUrls.add(post.url);
              this.totalPostsFound++;

              // Enqueue to jobQueue for full resolution
              await jobQueue.addJob(post.url, { quality: 'all', scope: 'all' });

              this.recentPosts.push({
                title: post.title,
                url: post.url,
                type: post.isSeries ? 'Series' : 'Movie',
                page: this.currentPage,
                discoveredAt: new Date(),
              });
              if (this.recentPosts.length > 50) this.recentPosts.shift();

              // Register into catalog dataset if new
              this._recordInCatalog(post);

              // Polite delay between individual post enqueues
              await new Promise((resolve) => setTimeout(resolve, this.delayMs));
            }
          }

          this.totalPagesCrawled++;
        }

        this.currentPage++;
        // Polite delay between page requests
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
    } catch (err) {
      logger.error(`[Site Crawler] Unhandled error: ${err.message}`);
      this.lastError = err.message;
    } finally {
      this.isRunning = false;
      this.isPaused = false;
      logger.discovered(
        `[Site Crawler] Finished crawl session. Total Pages: ${this.totalPagesCrawled}, Total Posts Enqueued: ${this.totalPostsFound}`
      );
    }
  }

  _buildPageUrl(pageNum) {
    const isXDMovies = isXDMoviesUrl(this.baseUrl);
    if (isXDMovies) {
      if (pageNum === 1) {
        return `${this.baseUrl}/`;
      }
      if (this.category) {
        const cleanCat = this.category.replace(/^\/+|\/+$/g, '');
        return `${this.baseUrl}/category.php?${cleanCat}&page=${pageNum}`;
      }
      return `${this.baseUrl}/?page=${pageNum}`;
    }

    let cleanCat = (this.category || '').trim().replace(/^\/+|\/+$/g, '');
    if (cleanCat && !cleanCat.startsWith('category/')) {
      cleanCat = `category/${cleanCat}`;
    }
    const catPart = cleanCat ? `/${cleanCat}` : '';
    if (pageNum === 1) {
      return `${this.baseUrl}${catPart}/`;
    }
    return `${this.baseUrl}${catPart}/page/${pageNum}/`;
  }

  _extractPostsFromHtml(html, pageUrl) {
    const $ = cheerio.load(html);
    const results = [];
    const localSeen = new Set();
    const isXDMovies = isXDMoviesUrl(pageUrl) || isXDMoviesUrl(this.baseUrl);

    if (isXDMovies) {
      $('a[href]').each((_, el) => {
        let href = $(el).attr('href') || '';
        if (!href || /\/category\/|\/page\/|\/tag\/|\/categories\/|#comment-/i.test(href)) return;
        if (/\/(?:movies|series)\/[a-z0-9-]+/i.test(href)) {
          const fullUrl = href.startsWith('http') ? href : new URL(href, pageUrl).href;
          if (!localSeen.has(fullUrl)) {
            localSeen.add(fullUrl);
            const isMovie = /\/movies\//i.test(fullUrl);
            const isSeries = /\/series\//i.test(fullUrl);
            const rawTitle =
              $(el).find('.title, h2, h3, .movie-title, .series-title, h4').text().trim() ||
              $(el).attr('title') ||
              $(el).find('img').attr('alt') ||
              $(el).text().trim();
            const cleanTitle = rawTitle.replace(/\s+/g, ' ').slice(0, 150).trim() || 'Untitled Release';

            results.push({
              title: cleanTitle,
              url: fullUrl,
              isMovie,
              isSeries,
            });
          }
        }
      });
      return results;
    }

    $('article, .movie-card, .post-item, .thumb, a').each((_, el) => {
      let href = $(el).attr('href') || '';
      if (!href && $(el).is('article, .movie-card, .thumb')) {
        href = $(el).find('a').first().attr('href') || '';
      }
      if (!href || /\/category\/|\/categories\/|\/tag\/|\/page\/|\/author\/|#comment-/i.test(href)) return;

      const mdMatch = href.match(/\[.*?\]\((https?:\/\/[^\s\)]+)\)/);
      if (mdMatch) href = mdMatch[1];

      const isMovie = /-movie(?:-\d+)?\/?$/i.test(href);
      const isSeries = /-series(?:-\d+)?\/?$/i.test(href);
      const isValid =
        isMovie ||
        isSeries ||
        /4khdhub\.[a-z0-9.]+\/[a-z0-9-]+-\d+\/?$/i.test(href);

      if (isValid) {
        const fullUrl = href.startsWith('http') ? href : new URL(href, pageUrl).href;
        if (!localSeen.has(fullUrl)) {
          localSeen.add(fullUrl);
          const rawTitle =
            $(el).find('.title, h2, h3, .entry-title').text().trim() ||
            $(el).attr('title') ||
            $(el).find('img').attr('alt') ||
            $(el).text().trim();
          const cleanTitle = rawTitle.replace(/\s+/g, ' ').slice(0, 150).trim() || 'Untitled Release';

          results.push({
            title: cleanTitle,
            url: fullUrl,
            isMovie,
            isSeries,
          });
        }
      }
    });

    return results;
  }

  _recordInCatalog(post) {
    const platform = this.platform || detectPlatformFromUrl(post.url);
    recordInCatalog({
      title: post.title,
      url: post.url,
      format: post.isSeries ? 'Series' : 'Movie',
      platform,
    });
  }
}

export const siteCrawler = new SiteCrawler();
export default {
  SiteCrawler,
  siteCrawler,
};
