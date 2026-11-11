import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const LOG_FILE = path.join(__dirname, 'scraper-daemon.log');
const PID_FILE = path.join(__dirname, 'daemon.pid');

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

function checkHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1500 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function killPortOwner(port) {
  try {
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' }
      );
    }
  } catch {}
}

function killRogueBots() {
  try {
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Get-Process -Name 'bot' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"`,
        { stdio: 'ignore' }
      );
    }
  } catch {}
}

// Single instance guard via PID file
function ensureSingleDaemon() {
  if (fs.existsSync(PID_FILE)) {
    try {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        // Check if process is still alive
        try {
          process.kill(oldPid, 0);
          log(`Daemon already running under PID ${oldPid}. Exiting duplicate supervisor.`);
          process.exit(0);
        } catch {
          // Process does not exist, stale PID file
          fs.unlinkSync(PID_FILE);
        }
      }
    } catch {}
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

let childProc = null;
let shouldRestart = true;
let consecutiveQuickCrashes = 0;

async function startSafeSupervisor() {
  ensureSingleDaemon();
  log(`Permanent localhost daemon supervisor active (PID: ${process.pid}) for port ${PORT}`);

  async function runChild() {
    if (!shouldRestart) return;

    // 1. Check if port is already held
    const portBusy = await isPortInUse(PORT);
    if (portBusy) {
      const isHealthy = await checkHealth(PORT);
      if (isHealthy) {
        log(`Port ${PORT} is already responding healthy. Attaching monitor without restarting...`);
        // Wait until it becomes unhealthy
        while (shouldRestart) {
          await new Promise((r) => setTimeout(r, 5000));
          const stillHealthy = await checkHealth(PORT);
          if (!stillHealthy) {
            log(`Existing server on port ${PORT} stopped responding. Restarting...`);
            break;
          }
        }
        if (!shouldRestart) return;
      }

      // If occupied but not healthy, clear it
      log(`Port ${PORT} occupied by stale/unhealthy process. Freeing port...`);
      killPortOwner(PORT);
      killRogueBots();
      await new Promise((r) => setTimeout(r, 1500));
    }

    const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const childEnv = {
      ...process.env,
      PORT: PORT.toString(),
      WORKER_CONCURRENCY: '1',
      MEDIATOR_CONCURRENCY: '1',
      NODE_OPTIONS: '--max-old-space-size=512',
    };

    const startTime = Date.now();
    childProc = spawn('node', ['src/index.js'], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
      windowsHide: true,
    });

    log(`Spawned server & Go bot process (PID: ${childProc.pid})`);

    childProc.stdout.on('data', (data) => logStream.write(data));
    childProc.stderr.on('data', (data) => logStream.write(data));

    childProc.on('exit', (code, signal) => {
      const runDuration = Date.now() - startTime;
      log(`Server process exited with code=${code}, signal=${signal} after ${(runDuration / 1000).toFixed(1)}s`);
      childProc = null;

      if (!shouldRestart) return;

      if (runDuration < 8000) {
        consecutiveQuickCrashes++;
      } else {
        consecutiveQuickCrashes = 0;
      }

      const backoffDelay = Math.min(15000, 2000 * Math.pow(1.5, Math.min(consecutiveQuickCrashes, 5)));
      log(`Auto-restarting server in ${(backoffDelay / 1000).toFixed(1)} seconds (quick crashes: ${consecutiveQuickCrashes})...`);
      setTimeout(runChild, backoffDelay);
    });

    childProc.on('error', (err) => {
      log(`Child process spawn error: ${err.message}`);
      if (shouldRestart) {
        setTimeout(runChild, 3000);
      }
    });
  }

  runChild();
}

function shutdown() {
  log('Shutting down permanent daemon supervisor...');
  shouldRestart = false;
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {}
  if (childProc) {
    try {
      childProc.kill('SIGINT');
    } catch {}
  }
  killRogueBots();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startSafeSupervisor();
