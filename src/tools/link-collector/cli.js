#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { LinkCollector } from './collector.js';

function printHelp() {
  console.log(`
🔍 Web Link Collector & Redirect Resolver
==========================================
Collects links from starting webpages, resolves HTTP redirect chains to their
final destinations, inspects HTTP status and page titles, and exports results to CSV.
Ethical by design: Respects robots.txt, applies polite rate limits, and does not bypass access controls.

Usage:
  node src/tools/link-collector/cli.js <url1> [url2...] [options]
  node src/tools/link-collector/cli.js --input urls.txt [options]

Options:
  --input, -i <file>        Path to text file containing starting URLs (one per line)
  --output, -o <file>       CSV output path (default: ./output/resolved_links.csv)
  --delay, -d <ms>          Delay between requests in milliseconds (default: 500)
  --concurrency, -c <num>   Maximum concurrent requests (default: 2)
  --timeout, -t <ms>        Request timeout in milliseconds (default: 10000)
  --max-redirects, -m <num> Maximum redirect hops to follow (default: 5)
  --assisted, -a <url>      Resolve a single protected/mediator link via assisted browser
  --user-agent <s>          Custom User-Agent string
  --no-robots               Disable robots.txt compliance checking
  --help, -h                Show this help screen

Examples:
  # Collect from a website:
  node src/tools/link-collector/cli.js https://example.com -o ./example_links.csv

  # Resolve an interactive mediator link with assisted browser:
  node src/tools/link-collector/cli.js --assisted "https://latestnewsonline.sbs/r/..."
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const startUrls = [];
  let inputFile = null;
  let outputFile = './output/resolved_links.csv';
  let delayMs = 500;
  let concurrency = 2;
  let timeoutMs = 10000;
  let maxRedirects = 5;
  let userAgent = 'LinkCollectorBot/1.0 (+https://example.com/bot; legitimate link auditor)';
  let respectRobotsTxt = true;
  let assistedDirectUrl = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input' || arg === '-i') {
      inputFile = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      outputFile = args[++i];
    } else if (arg === '--delay' || arg === '-d') {
      delayMs = parseInt(args[++i], 10);
    } else if (arg === '--concurrency' || arg === '-c') {
      concurrency = parseInt(args[++i], 10);
    } else if (arg === '--timeout' || arg === '-t') {
      timeoutMs = parseInt(args[++i], 10);
    } else if (arg === '--max-redirects' || arg === '-m') {
      maxRedirects = parseInt(args[++i], 10);
    } else if (arg === '--assisted' || arg === '-a') {
      assistedDirectUrl = args[++i];
    } else if (arg === '--user-agent') {
      userAgent = args[++i];
    } else if (arg === '--no-robots') {
      respectRobotsTxt = false;
    } else if (arg.startsWith('http://') || arg.startsWith('https://')) {
      startUrls.push(arg);
    }
  }

  // Handle single direct assisted resolution
  if (assistedDirectUrl) {
    console.log(`\n🚀 Launching Assisted Resolver for: ${assistedDirectUrl}`);
    const { AssistedResolver } = await import('./assisted-resolver.js');
    const resolver = new AssistedResolver({ timeoutMs: 120000 });
    const result = await resolver.resolve(assistedDirectUrl);

    if (!result.finalUrl || result.error) {
      console.log(`\n⚠️  Resolution Stopped!`);
      console.log(`------------------------------------------`);
      console.log(`• Destination URL : ${result.finalUrl || '(not returned)'}`);
      console.log(`• Status          : HTTP ${result.httpStatus || 0}`);
      console.log(`• Note            : ${result.error || 'Destination was not returned'}`);
      if (result.redirectChain?.length > 0) {
        console.log(`• Recorded Redirects (${result.redirectChain.length} hops):`);
        for (const hop of result.redirectChain) {
          console.log(`    [HTTP ${hop.status}] ${hop.fromUrl} -> ${hop.location || '(missing Location header)'}`);
        }
      }
      console.log(`------------------------------------------\n`);
      process.exit(1);
    }

    console.log(`\n✅ Resolution Complete!`);
    console.log(`------------------------------------------`);
    console.log(`• Destination URL : ${result.finalUrl}`);
    console.log(`• Status          : HTTP ${result.httpStatus}`);
    console.log(`• Title           : ${result.pageTitle}`);
    console.log(`• Cookies Preserved: ${result.cookies?.length || 0}`);
    if (result.redirectChain?.length > 0) {
      console.log(`• Recorded Redirects (${result.redirectChain.length} hops):`);
      for (const hop of result.redirectChain) {
        console.log(`    [HTTP ${hop.status}] ${hop.fromUrl} -> ${hop.location || '(missing Location header)'}`);
      }
    }
    console.log(`------------------------------------------\n`);
    process.exit(0);
  }

  if (inputFile) {
    if (!fs.existsSync(inputFile)) {
      console.error(`❌ Input file not found: ${inputFile}`);
      process.exit(1);
    }
    const lines = fs.readFileSync(inputFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && (trimmed.startsWith('http://') || trimmed.startsWith('https://'))) {
        startUrls.push(trimmed);
      }
    }
  }

  if (startUrls.length === 0) {
    console.error('❌ No valid starting URLs provided. Use --help for usage.');
    process.exit(1);
  }

  console.log(`\n🚀 Initializing Link Collector & Redirect Resolver`);
  console.log(`--------------------------------------------------`);
  console.log(`• Starting Pages   : ${startUrls.length}`);
  console.log(`• Output File      : ${path.resolve(outputFile)}`);
  console.log(`• Rate Limit Delay : ${delayMs}ms`);
  console.log(`• Concurrency      : ${concurrency}`);
  console.log(`• Timeout          : ${timeoutMs}ms`);
  console.log(`• Max Redirects    : ${maxRedirects}`);
  console.log(`• Robots.txt Check : ${respectRobotsTxt ? 'Enabled' : 'Disabled'}`);
  console.log(`• User Agent       : ${userAgent}`);
  console.log(`--------------------------------------------------\n`);

  const collector = new LinkCollector({
    concurrency,
    delayMs,
    timeoutMs,
    maxRedirects,
    respectRobotsTxt,
    userAgent,
    outputPath: outputFile,
    onProgress: (prog) => {
      const statusStr = prog.status ? `(HTTP ${prog.status})` : '';
      const dest = prog.finalUrl ? `-> ${prog.finalUrl.slice(0, 55)}` : '';
      process.stdout.write(`\r[${prog.processed}/${prog.total}] Resolving: ${prog.current.slice(0, 40)} ${dest} ${statusStr}   `);
    },
  });

  const result = await collector.run(startUrls);

  console.log(`\n\n✅ Link Collection & Resolution Complete!`);
  console.log(`------------------------------------------`);
  console.log(`• Total Links Discovered : ${result.summary.totalDiscovered}`);
  console.log(`• Successfully Resolved  : ${result.summary.resolved}`);
  console.log(`• Errors / Disallowed    : ${result.summary.errors}`);
  console.log(`• Execution Time         : ${(result.summary.durationMs / 1000).toFixed(2)}s`);
  console.log(`• CSV Output Path        : ${path.resolve(outputFile)}`);
  console.log(`------------------------------------------\n`);
}

main().catch((err) => {
  console.error('\n❌ Fatal execution error:', err.message);
  process.exit(1);
});
