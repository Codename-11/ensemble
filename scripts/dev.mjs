#!/usr/bin/env node

/**
 * scripts/dev.mjs — Cross-platform dev orchestrator for Ensemble.
 *
 * Starts both the ensemble server and the web SPA dev server in parallel.
 * Shows combined colored output with prefixes.
 * Handles Ctrl+C gracefully (kills both children).
 * Opens the SPA URL in the default browser after both are ready.
 *
 * Usage: node scripts/dev.mjs [--no-open] [--server-only] [--web-only]
 *
 * Uses ONLY Node built-ins (child_process, http, os, path, url).
 */

import { spawn } from 'child_process';
import { request } from 'http';
import { platform } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// ────────────────────────── ANSI colors ──────────────────────────────────

const CSI = '\x1b[';
const c = {
  reset:       `${CSI}0m`,
  bold:        `${CSI}1m`,
  dim:         `${CSI}2m`,
  cyan:        `${CSI}36m`,
  magenta:     `${CSI}35m`,
  brightCyan:  `${CSI}96m`,
  brightGreen: `${CSI}92m`,
  gray:        `${CSI}90m`,
};

// ────────────────────────── Paths & flags ────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB_DIR = resolve(ROOT, 'web');

const args = process.argv.slice(2);
const noOpen     = args.includes('--no-open');
const serverOnly = args.includes('--server-only');
const webOnly    = args.includes('--web-only');

const SERVER_PORT = parseInt(process.env.ENSEMBLE_PORT || '23000', 10);
const WEB_PORT    = 5173;
const SERVER_URL  = `http://127.0.0.1:${SERVER_PORT}`;
const WEB_URL     = `http://localhost:${WEB_PORT}`;

// ────────────────────────── Helpers ──────────────────────────────────────

/** Print branded header. */
function header() {
  console.log(`\n  ${c.brightCyan}\u25C8 ${c.bold}ensemble dev${c.reset}\n`);
}

/** Prefix every line of a chunk with a colored tag. */
function prefixer(tag, color) {
  const prefix = `  ${color}${tag}${c.reset} `;
  return (chunk) => {
    const text = chunk.toString();
    // Split but preserve trailing newline behavior
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    // The last element after split on a trailing newline is '', skip it
    for (let i = 0; i < lines.length; i++) {
      if (i === lines.length - 1 && lines[i] === '') continue;
      process.stdout.write(prefix + lines[i] + '\n');
    }
  };
}

/** Health-check the server by hitting /api/v1/health. */
function checkServerHealth() {
  return new Promise((resolve) => {
    const req = request(
      `${SERVER_URL}/api/v1/health`,
      { timeout: 1000 },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(res.statusCode === 200));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** Poll until fn() resolves truthy, with timeout. */
async function waitFor(fn, label, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`  ${c.dim}[timeout]${c.reset} ${label} did not become ready within ${timeoutMs / 1000}s`);
  return false;
}

/** Open a URL in the default browser. */
function openBrowser(url) {
  const plat = platform();
  let cmd, cmdArgs;
  if (plat === 'darwin') {
    cmd = 'open';
    cmdArgs = [url];
  } else if (plat === 'win32') {
    cmd = 'cmd';
    cmdArgs = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    cmdArgs = [url];
  }
  const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
  child.unref();
}

// ────────────────────────── Process management ──────────────────────────

const children = [];

function killAll() {
  for (const child of children) {
    if (!child.killed) {
      // On Windows, child_process trees need taskkill; otherwise SIGTERM.
      if (platform() === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGTERM');
      }
    }
  }
}

process.on('SIGINT', () => { killAll(); process.exit(0); });
process.on('SIGTERM', () => { killAll(); process.exit(0); });

// ────────────────────────── Spawn children ──────────────────────────────

header();

let serverReady = serverOnly || (!serverOnly && !webOnly) ? false : true;
let webReady    = webOnly || (!serverOnly && !webOnly) ? false : true;

// Resolve to determine which npm / tsx to use (respects Windows .cmd shims)
const isWin = platform() === 'win32';
const npxCmd = isWin ? 'npx.cmd' : 'npx';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

// ── Server ──────────────────────────────────────────────────────────────

if (!webOnly) {
  const serverProc = spawn(npxCmd, ['tsx', 'server.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    shell: isWin,
  });
  children.push(serverProc);

  const serverOut = prefixer('[server]', c.cyan);
  serverProc.stdout.on('data', (chunk) => {
    serverOut(chunk);
    // Quick-detect readiness from the server's own output
    if (chunk.toString().includes('Server running on')) {
      serverReady = true;
    }
  });
  serverProc.stderr.on('data', serverOut);

  serverProc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`  ${c.dim}[server]${c.reset} exited with code ${code}`);
    }
    killAll();
    process.exit(code || 0);
  });
}

// ── Web ─────────────────────────────────────────────────────────────────

if (!serverOnly) {
  const webProc = spawn(npmCmd, ['run', 'dev'], {
    cwd: WEB_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    shell: isWin,
  });
  children.push(webProc);

  const webOut = prefixer('[web]   ', c.magenta);
  webProc.stdout.on('data', (chunk) => {
    webOut(chunk);
    const text = chunk.toString();
    if (text.includes('ready') || text.includes('Local:') || text.includes('localhost')) {
      webReady = true;
    }
  });
  webProc.stderr.on('data', webOut);

  webProc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`  ${c.dim}[web]${c.reset} exited with code ${code}`);
    }
    killAll();
    process.exit(code || 0);
  });
}

// ── Wait for readiness & open browser ───────────────────────────────────

async function waitAndOpen() {
  // Wait for server health if we're running it
  if (!webOnly) {
    const ok = await waitFor(
      async () => serverReady && (await checkServerHealth()),
      'Server',
      30_000,
    );
    if (ok) {
      console.log(`  ${c.brightGreen}\u2713${c.reset} Server ready on ${c.dim}${SERVER_URL}${c.reset}`);
    }
  }

  // Wait for web dev server if we're running it
  if (!serverOnly) {
    const ok = await waitFor(() => Promise.resolve(webReady), 'Web', 30_000);
    if (ok) {
      console.log(`  ${c.brightGreen}\u2713${c.reset} Web ready on ${c.dim}${WEB_URL}${c.reset}`);
    }
  }

  // Open the browser
  if (!noOpen) {
    const url = serverOnly ? SERVER_URL : WEB_URL;
    console.log(`\n  Opening ${c.dim}${url}${c.reset}...\n`);
    openBrowser(url);
  }
}

waitAndOpen();
