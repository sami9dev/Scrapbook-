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
  const line = `[${new Date().toISOString()}] [PERMANENT-DAEMON] ${msg}\n`;
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
  log(`Permanent localhost daemon supervisor initiated for port ${PORT}...`);

  function runChild() {
    if (!shouldRestart) return;

    const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
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

    log(`Spawned permanent server & Go bot process (PID: ${childProc.pid})`);

    childProc.stdout.on('data', (data) => logStream.write(data));
    childProc.stderr.on('data', (data) => logStream.write(data));

    childProc.on('exit', (code, signal) => {
      log(`Server process exited with code=${code}, signal=${signal}`);
      childProc = null;
      if (shouldRestart) {
        log('Auto-restarting server in 2 seconds...');
        setTimeout(runChild, 2000);
      }
    });

    childProc.on('error', (err) => {
      log(`Child process error: ${err.message}`);
      if (shouldRestart) {
        setTimeout(runChild, 3000);
      }
    });
  }

  // Clear any zombie process holding the port before spawning child
  const inUse = await isPortInUse(PORT);
  if (inUse) {
    log(`Port ${PORT} is held by a prior process. Freeing port before launch...`);
    try {
      const { execSync } = await import('node:child_process');
      if (process.platform === 'win32') {
        execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`);
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1200));
  }

  runChild();
}

function shutdown() {
  log('Shutting down permanent daemon supervisor...');
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
