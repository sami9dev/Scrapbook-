# Authorized Link-Discovery & Metadata Scraper

A production-quality, modular scraper for authorized websites (sites you own or have explicit permission to scrape). The application discovers publicly exposed download/provider links, follows ordinary redirects and navigation, extracts structured metadata, normalizes file sizes, records mirror links, prevents duplicates, and stores records in MongoDB with a real-time dark admin dashboard.

---

## 🛡️ Compliance & Safety Boundaries

This application is strictly designed for **authorized use only**:

* **No CAPTCHA / Turnstile Bypasses**: Does **not** implement mechanisms intended to defeat Cloudflare Turnstile, CAPTCHAs, bot challenges, or access controls.
* **Explicit Challenge Interception**: If a challenge or human verification is encountered, the automated flow cleanly stops and reports:
  ```json
  {
    "status": "HUMAN_VERIFICATION_REQUIRED",
    "message": "Manual verification required."
  }
  ```
* **SSRF Defense-in-Depth**: Strict IP and protocol validation blocks private network ranges (RFC 1918, RFC 4193, loopback, link-local, carrier-grade NAT, and IPv4-mapped IPv6). Only `http:` and `https:` protocols are accepted.
* **Opaque Token Handling**: Tokens such as `?file=eyJ...` are preserved as opaque identifiers and are **never** assumed to be base64-decoded into destination URLs.
* **Zero Credential Logging**: All logs sanitize authorization headers, cookies, tokens, and passwords.

---

## 📐 Architecture Pipeline

```text
SOURCE PAGE
    ↓
Source Parser (title, year, season, codec, audio, relative link resolution)
    ↓
Provider-Link Discovery (intermediate page inspection, token preservation)
    ↓
Normal HTTP Redirect Resolution (301, 302, 303, 307, 308 up to MAX_REDIRECTS=10)
    ↓
Intermediate Page Parser (<a href>, <form action>, meta refresh, canonical, embedded JSON)
    ↓
Publicly Exposed Destination Detection
    ↓
GDFLIX / Provider Parser (provider registry, file ID, public file-info page)
    ↓
Metadata Normalizer (quality, audio channels, languages, size in bytes & display)
    ↓
Deduplication (compound key fingerprinting)
    ↓
MongoDB (scraped_links collection with compound unique indexes)
    ↓
REST API & Dark Admin Dashboard
```

---

## 📁 Project Structure

```text
scraper/
├── src/
│   ├── index.js                     # Application entry point & server
│   ├── api/
│   │   └── routes.js                # REST API endpoints
│   ├── config/
│   │   └── config.js                # Configuration with environment variables
│   ├── database/
│   │   ├── mongodb.js               # MongoDB driver & in-memory test fallback
│   │   └── models.js                # Schemas, status model & repositories
│   ├── discovery/
│   │   ├── browser-fetcher.js       # Playwright browser fallback for JS DOM
│   │   ├── http-client.js           # HTTP client with exponential backoff
│   │   ├── link-discovery.js        # Intermediate page discovery & token extraction
│   │   └── redirect-resolver.js     # Manual redirect tracker with SSRF checks
│   ├── logging/
│   │   └── logger.js                # Logger with tag prefixes & credential redaction
│   ├── parsing/
│   │   ├── html-parser.js           # Cheerio HTML parser & challenge detector
│   │   ├── metadata-parser.js       # Filename metadata extractor
│   │   └── mirror-parser.js         # Exposed mirror link parser
│   ├── providers/
│   │   ├── gdflix.js                # GDFLIX provider parser
│   │   ├── generic.js               # Generic fallback provider parser
│   │   └── provider-registry.js     # Extensible provider registry
│   ├── public/
│   │   └── index.html               # Dark dashboard admin UI
│   ├── queue/
│   │   └── job-queue.js             # Concurrency-controlled pipeline orchestrator
│   ├── sources/
│   │   └── source-parser.js         # Source page metadata & link extractor
│   └── utils/
│       ├── dedupe.js                # Unique key fingerprinting & deduplication
│       ├── normalize.js             # Size parser & byte normalizer
│       └── url.js                   # URL validator & SSRF prevention
├── tests/
│   ├── phase1.test.js               # Phase 1: URL, SSRF, redirects, HTML parser
│   ├── phase2_3.test.js             # Phase 2 & 3: Source, providers, metadata, mirrors
│   ├── phase4.test.js               # Phase 4: MongoDB, deduplication, job statuses
│   ├── phase5_6.test.js             # Phase 5 & 6: REST API & browser controls
│   └── e2e.test.js                  # Phase 7: Complete end-to-end pipeline
├── fixtures/
│   ├── captcha-page.html            # Cloudflare Turnstile challenge fixture
│   ├── gdflix-page.html             # GDFLIX file-information fixture
│   ├── intermediate-page.html       # Intermediate continue-link fixture
│   ├── malformed-page.html          # Broken/malformed HTML fixture
│   ├── redirect-page.html           # Meta refresh & canonical fixture
│   └── source-page.html             # Authorized source page fixture
├── .env.example
├── package.json
└── README.md
```

---

## 🚀 Quick Start

### 1. Installation

```bash
cd scraper
npm install
```

### 2. Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Configuration variables in `.env`:
* `PORT`: Server port (default: `3000`)
* `MONGODB_URI`: MongoDB connection string (e.g., `mongodb://localhost:27017/scraper_db`)
* `REQUEST_TIMEOUT`: Timeout in milliseconds (default: `15000`)
* `MAX_REDIRECTS`: Maximum redirect chain depth (default: `10`)
* `MAX_RETRIES`: Maximum retry attempts for transient server errors (default: `2`)
* `CONCURRENCY`: Parallel worker count (default: `3`)
* `USER_AGENT`: Descriptive crawler identity (`AuthorizedMetadataScraper/1.0`)
* `ALLOWED_DOMAINS`: Optional comma-separated list of authorized domains

### 3. Running the Server

```bash
npm start
```

Visit the dark dashboard at:
```text
http://localhost:3000/
```

### 4. Running the Tests

```bash
npm test
```

---

## 📡 REST API Reference

### Submit a Scrape Job

`POST /api/scrape`

**Request Body:**
```json
{
  "url": "https://example-authorized-site.test/tvshows/example-show/"
}
```

**Response (202 Accepted):**
```json
{
  "jobId": "hnz3x7oacs7",
  "status": "DISCOVERED",
  "url": "https://example-authorized-site.test/tvshows/example-show/",
  "createdAt": "2026-09-25T16:50:00.000Z"
}
```

---

### Get Job Status

`GET /api/jobs/:id`

**Response (200 OK):**
```json
{
  "_id": "hnz3x7oacs7",
  "url": "https://example-authorized-site.test/tvshows/example-show/",
  "status": "RESOLVED",
  "resultsCount": 1,
  "extractedLinks": ["x7przfspbvi"],
  "error": null,
  "createdAt": "2026-09-25T16:50:00.000Z",
  "updatedAt": "2026-09-25T16:50:02.000Z"
}
```

---

### Get Scraped Records

`GET /api/links?limit=50&status=RESOLVED`

**Response (200 OK):**
```json
[
  {
    "_id": "x7przfspbvi",
    "sourceUrl": "https://example-authorized-site.test/tvshows/example-show/",
    "sourceDomain": "example-authorized-site.test",
    "title": "Example Show",
    "year": 2026,
    "type": "tv",
    "season": 1,
    "episode": null,
    "quality": "2160p",
    "codec": "H.265",
    "provider": "GDFLIX",
    "providerUrl": "https://provider.example/file/9QWlfgZTmmiv837",
    "fileId": "9QWlfgZTmmiv837",
    "filename": "Example.Show.2026.S01.2160p.HS.WEB-DL.MULTI.DDPA.5.1.Atmos.H.265.zip",
    "format": "zip",
    "sizeBytes": 42380591104,
    "sizeDisplay": "39.47 GB",
    "mirrors": [
      {
        "name": "Mirror 1 - Fast Direct",
        "url": "https://mirror1.example/download/fast123",
        "type": "direct"
      }
    ],
    "status": "RESOLVED",
    "redirectChain": [
      "https://example-authorized-site.test/some/path"
    ],
    "dedupeKey": "https://example-authorized-site.test/tvshows/example-show/::https://provider.example/file/9qwlfgztmmiv837::9QWlfgZTmmiv837",
    "createdAt": "2026-09-25T16:50:02.000Z",
    "updatedAt": "2026-09-25T16:50:02.000Z"
  }
]
```

---

### Get Aggregate Stats

`GET /api/stats`

**Response (200 OK):**
```json
{
  "total": 12,
  "resolved": 10,
  "partial": 1,
  "humanVerification": 1,
  "errors": 0
}
```

---

## 🚦 Status Model

| Status | Meaning |
|---|---|
| `DISCOVERED` | URL submitted and enqueued |
| `REDIRECTING` | Following ordinary HTTP redirects |
| `PARSING` | Active extraction of source, intermediate, or provider page |
| `RESOLVED` | Successfully extracted provider metadata and stored in MongoDB |
| `PARTIAL` | Some links resolved or no downloadable provider found |
| `HUMAN_VERIFICATION_REQUIRED` | Cloudflare / CAPTCHA challenge detected; automation halted cleanly |
| `ACCESS_DENIED` | Blocked by SSRF checks, private IP ranges, or 401/403 |
| `NOT_FOUND` | Source or provider returned 404 |
| `REDIRECT_LIMIT_EXCEEDED` | Redirect chain depth exceeded `MAX_REDIRECTS=10` or circular loop |
| `TIMEOUT` | Request exceeded `REQUEST_TIMEOUT=15000ms` |
| `ERROR` | Non-recoverable processing error |
