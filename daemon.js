import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const LOG_FILE = path.join(__dirname, 'scraper-daemon.log');

/**
 * Checks if a TCP port is in use.
 */
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

function log(msg) {
  const line = `[${new Date().toISOString()}] [DAEMON] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {}
  process.stdout.write(line);
}

let child = null;
let shouldRestart = true;

async function startSupervisor() {
  const inUse = await isPortInUse(PORT);
  if (inUse) {
    log(`Port ${PORT} is already active. Scraper is already running.`);
    process.exit(0);
  }

  log(`Starting persistent Scraper Daemon on port ${PORT}...`);

  function runChild() {
    if (!shouldRestart) return;

    const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const childProc = spawn('node', ['src/index.js'], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    });

    child = childProc;
    log(`Spawned child server process (PID: ${childProc.pid})`);

    childProc.stdout.on('data', (data) => {
      logStream.write(data);
    });

    childProc.stderr.on('data', (data) => {
      logStream.write(data);
    });

    childProc.on('exit', (code, signal) => {
      log(`Child process exited with code=${code}, signal=${signal}`);
      child = null;
      if (shouldRestart) {
        log('Auto-restarting server in 2 seconds...');
        setTimeout(runChild, 2000);
      }
    });

    childProc.on('error', (err) => {
      log(`Error spawning child process: ${err.message}`);
      if (shouldRestart) {
        setTimeout(runChild, 3000);
      }
    });
  }

  runChild();
}

process.on('SIGINT', () => {
  log('Received SIGINT. Shutting down daemon...');
  shouldRestart = false;
  if (child) child.kill('SIGINT');
  setTimeout(() => process.exit(0), 500);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM. Shutting down daemon...');
  shouldRestart = false;
  if (child) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
});

startSupervisor();
