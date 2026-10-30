import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const LOG_FILE = path.join(__dirname, 'scraper-daemon.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] [SAFE-DAEMON] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {}
  process.stdout.write(line);
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

let childProc = null;
let shouldRestart = true;

async function startSafeSupervisor() {
  if (process.env.ENABLE_LOCAL_SCRAPER !== 'true') {
    log('Local browser-heavy scraper worker is disabled on Windows to prevent PC freezing.');
    log('All link resolution and scraping jobs run asynchronously on the Render cloud worker.');
    return;
  }

  const inUse = await isPortInUse(PORT);
  if (inUse) {
    log(`Port ${PORT} is already active.`);
    return;
  }

  log(`Starting single resource-guarded Scraper on port ${PORT} (Protects Windows PC from freezing)...`);

  function runChild() {
    if (!shouldRestart) return;

    const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    // Enforce safe single-worker limits to keep Windows smooth and responsive
    const childEnv = {
      ...process.env,
      PORT: PORT.toString(),
      WORKER_CONCURRENCY: '1',
      MEDIATOR_CONCURRENCY: '1',
      NODE_OPTIONS: '--max-old-space-size=512',
    };

    childProc = spawn('node', ['src/index.js'], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
      windowsHide: true,
    });

    log(`Spawned safe scraper process (PID: ${childProc.pid})`);

    childProc.stdout.on('data', (data) => logStream.write(data));
    childProc.stderr.on('data', (data) => logStream.write(data));

    childProc.on('exit', (code, signal) => {
      log(`Scraper exited with code=${code}, signal=${signal}`);
      childProc = null;
      if (shouldRestart) {
        log('Auto-restarting in 2 seconds...');
        setTimeout(runChild, 2000);
      }
    });

    childProc.on('error', (err) => {
      log(`Error: ${err.message}`);
      if (shouldRestart) {
        setTimeout(runChild, 3000);
      }
    });
  }

  runChild();
}

function shutdown() {
  shouldRestart = false;
  if (childProc) {
    try {
      childProc.kill('SIGINT');
    } catch {}
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startSafeSupervisor();
