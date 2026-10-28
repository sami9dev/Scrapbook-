# 🔍 Web Link Collector & Redirect Resolver

A legitimate, compliant Node.js tool designed to collect hyperlinks from publicly accessible web pages, trace their HTTP redirect chains to find their final destination URLs, inspect HTTP status codes and page titles, and export the audited data to CSV.

Ethical and polite by design:
- ✅ **Robots.txt Compliant**: Automatically inspects and obeys `robots.txt` allow/disallow rules.
- ✅ **Polite Rate Limiting**: Enforces configurable delays between requests and limits concurrency to avoid putting strain on target web servers.
- ✅ **No Access Control Bypasses**: Does not bypass logins, paywalls, or CAPTCHA verification challenges. Protected endpoints are clearly marked with their exact HTTP response code (`401`, `403`, or challenge note) without attempting bypass.
- ✅ **Resilient Error Handling**: Safely handles timeouts, redirect loops, and DNS failures.

---

## 📦 Requirements & Installation

- **Node.js**: `v20.0.0` or higher
- **Dependencies**: `cheerio` (already present in the project)

No extra installation is required if you are already in the project workspace:
```bash
npm install
```

---

## 🚀 Quick Start (CLI)

### 1. Collect and Resolve Links from Starting URLs
Run the CLI directly by passing one or more starting webpage URLs:

```bash
node src/tools/link-collector/cli.js https://example.com/
```

### 2. Save Output to a Custom CSV File
```bash
node src/tools/link-collector/cli.js https://example.com/ -o ./output/my_links.csv
```

### 3. Supply Starting URLs via a Text File
Create a `urls.txt` file with one URL per line:
```text
https://example.com/about
https://example.com/resources
```

Run the collector:
```bash
node src/tools/link-collector/cli.js --input urls.txt --output ./results.csv
```

### 4. Custom Rate Limiting & Concurrency
Control request timing to keep crawls respectful:
```bash
node src/tools/link-collector/cli.js https://example.com/ --delay 1000 --concurrency 1 --timeout 15000
```

### 5. Assisted Resolution for Protected / Mediator Links
Automates initial button clicks and countdowns, prompts you for the Turnstile verification checkbox in a visible browser, and captures the final destination URL:
```bash
node src/tools/link-collector/cli.js --assisted "https://latestnewsonline.sbs/r/d3BnHcTz"
```

---

## ⚙️ CLI Options Reference

| Flag | Short | Default | Description |
|---|---|---|---|
| `--input <file>` | `-i` | `null` | Path to a file containing starting URLs (one per line). |
| `--output <file>` | `-o` | `./output/resolved_links.csv` | Output path for the generated CSV file. |
| `--delay <ms>` | `-d` | `500` | Polite delay in milliseconds between requests. |
| `--concurrency <num>` | `-c` | `2` | Maximum number of concurrent resolver requests. |
| `--timeout <ms>` | `-t` | `10000` | HTTP request timeout in milliseconds. |
| `--max-redirects <num>` | `-m` | `5` | Maximum number of redirect hops to follow before halting. |
| `--assisted <url>` | `-a` | `null` | Open an assisted browser session to resolve an interactive mediator link. |
| `--user-agent <str>` | | `LinkCollectorBot/1.0 (+...)` | Custom User-Agent header string. |
| `--no-robots` | | `false` | Disable robots.txt checking (enabled by default). |
| `--help` | `-h` | | Show usage help and options. |

---

## 📊 CSV Output Format

The output CSV conforms to the **RFC 4180** standard with proper escaping for quotes, commas, and newlines:

| Column | Description | Example |
|---|---|---|
| **Original URL** | The raw link as extracted from the anchor tag on the source page. | `http://example.com/shortlink` |
| **Final URL** | The final landing URL after resolving all 301/302/307/308 redirects. | `https://example.com/destination` |
| **HTTP Status** | The final HTTP status code returned by the destination server. | `200` |
| **Page Title** | The `<title>` extracted from the destination HTML page. | `Example Domain - Resources` |
| **Redirect Count** | Number of intermediate redirects followed. | `2` |
| **Source Page** | The page on which the link was originally discovered. | `https://example.com/` |
| **Error / Status Note** | Any error encountered (e.g. timeout, DNS error, challenge detected). | `""` or `Timeout after 10000ms` |

---

## 💻 Programmatic API Usage

You can also import and use the collector directly within your own Node.js scripts:

```javascript
import { LinkCollector } from './src/tools/link-collector/index.js';

const collector = new LinkCollector({
  concurrency: 2,
  delayMs: 500,
  timeoutMs: 10000,
  maxRedirects: 5,
  respectRobotsTxt: true,
  outputPath: './output/my_results.csv',
  onProgress: ({ processed, total, current, status }) => {
    console.log(`[${processed}/${total}] ${current} -> Status: ${status}`);
  },
});

const result = await collector.run([
  'https://example.com/page1',
  'https://example.com/page2'
]);

console.log(`Discovered: ${result.summary.totalDiscovered}`);
console.log(`Resolved: ${result.summary.resolved}`);
console.log(`CSV Output:\n${result.csv.slice(0, 300)}...`);
```

---

## 🛡️ Ethical Scraping Best Practices

1. **Robots.txt Compliance**: The tool checks `/robots.txt` before fetching starting pages and extracted links. If a URL is disallowed by a `Disallow` rule for the user agent, it is skipped and recorded with status `403 (Disallowed by robots.txt)`.
2. **Rate Limiting**: Always configure `--delay` to an appropriate interval (500ms to 2000ms) to prevent overwhelming target hosts.
3. **No Access Bypasses**: The tool intentionally respects access controls and does not attempt to bypass login pages, paywalls, or bot verification challenges.
