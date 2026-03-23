#!/usr/bin/env node
/**
 * collab-launch.mjs — Cross-platform team launcher
 * Replaces collab-launch.sh (which depends on bash/tmux/Python).
 *
 * Usage: node collab-launch.mjs <working-dir> <task-description> [agents]
 *
 * Orchestrates: health-check server, create team, start bridge, open monitor,
 * start poller, wait for agents.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import http from 'http'
import { spawn, execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(__filename)
const REPO_DIR = path.resolve(SCRIPT_DIR, '..')

const CWD = process.argv[2] || '.'
const TASK = process.argv[3]
const AGENTS = process.argv[4] || '' // comma-separated agent names

if (!TASK) {
  console.error('Usage: node collab-launch.mjs <cwd> <task>')
  process.exit(1)
}

const API = process.env.ENSEMBLE_URL || 'http://localhost:23000'
const HOST_ID = process.env.ENSEMBLE_HOST_ID || 'local'
const runtimeRoot = process.env.ENSEMBLE_RUNTIME_DIR
  || path.join(os.tmpdir(), 'ensemble')

// ─── Colors ───
const G = '\x1b[92m'
const C = '\x1b[96m'
const D = '\x1b[2m'
const W = '\x1b[97m'
const BD = '\x1b[1m'
const R = '\x1b[0m'
const RED = '\x1b[91m'
const CHECK = `${G}\u2713${R}`
const SPIN = `${C}\u25CF${R}`

function log(msg) { process.stdout.write(msg + '\n') }

// ─── HTTP helpers ───

function httpGet(urlStr, timeout = 3000) {
  return new Promise((resolve, reject) => {
    http.get(urlStr, { timeout }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ status: res.statusCode, data }))
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')) })
  })
}

function httpPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const url = new URL(urlStr)
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ status: res.statusCode, data }))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Main ───

async function main() {
  log('')
  log(`  ${BD}${W}\u25C8 agent-forge collab${R}`)
  log(`  ${D}${TASK.slice(0, 80)}${R}`)
  log('')

  // ─── 1. Server ───
  try {
    await httpGet(`${API}/api/v1/health`)
    log(`  ${CHECK} Server running`)
  } catch {
    process.stdout.write(`  ${SPIN} Starting server...`)
    const serverLog = path.join(os.tmpdir(), 'ensemble-server.log')
    const tsxBin = path.join(REPO_DIR, 'node_modules', '.bin', 'tsx')
    const serverProc = spawn(tsxBin, ['server.ts'], {
      cwd: REPO_DIR,
      stdio: ['ignore', fs.openSync(serverLog, 'w'), fs.openSync(serverLog, 'a')],
      detached: true,
      shell: os.platform() === 'win32',
    })
    serverProc.unref()

    let started = false
    for (let i = 0; i < 8; i++) {
      await sleep(1000)
      try {
        await httpGet(`${API}/api/v1/health`)
        started = true
        break
      } catch { /* waiting */ }
    }
    if (started) {
      log(`\r  ${CHECK} Server started       `)
    } else {
      log(`\r  ${RED}\u2717${R} Server failed to start`)
      process.exit(1)
    }
  }

  // ─── 2. Create team ───
  const teamName = `collab-${Date.now()}-${Math.floor(Math.random() * 9000) + 1000}`
  const agents = AGENTS
    ? AGENTS.split(',').map((name, i) => ({
        program: name.trim(),
        role: i === 0 ? 'lead' : 'worker',
        hostId: HOST_ID,
      }))
    : [
        { program: 'codex', role: 'lead', hostId: HOST_ID },
        { program: 'claude code', role: 'worker', hostId: HOST_ID },
      ]

  const result = await httpPost(`${API}/api/ensemble/teams`, {
    name: teamName,
    description: TASK,
    agents,
    feedMode: 'live',
    workingDirectory: CWD,
  })

  const teamData = JSON.parse(result.data)
  const teamId = teamData.team.id
  const teamDir = path.join(runtimeRoot, teamId)
  const messagesFile = path.join(teamDir, 'messages.jsonl')
  const feedFile = path.join(teamDir, 'feed.txt')
  const pollerPidFile = path.join(teamDir, 'poller.pid')
  const bridgeLogFile = path.join(teamDir, 'bridge.log')
  const teamIdFile = path.join(teamDir, 'team-id')
  const latestTeamFile = path.join(os.tmpdir(), 'collab-team-id.txt')

  fs.mkdirSync(teamDir, { recursive: true })
  if (!fs.existsSync(messagesFile)) fs.writeFileSync(messagesFile, '')
  fs.writeFileSync(teamIdFile, teamId + '\n')
  fs.writeFileSync(latestTeamFile, teamId + '\n')

  log(`  ${CHECK} Team created ${D}(${teamName})${R}`)

  // ─── 3. Bridge ───
  const bridgeScript = path.join(SCRIPT_DIR, 'ensemble-bridge.mjs')
  const bridgeProc = spawn('node', [bridgeScript, teamId, API], {
    cwd: REPO_DIR,
    stdio: ['ignore', fs.openSync(bridgeLogFile, 'a'), fs.openSync(bridgeLogFile, 'a')],
    detached: true,
    shell: os.platform() === 'win32',
  })
  bridgeProc.unref()
  log(`  ${CHECK} Bridge started`)

  // ─── 4. Monitor ───
  // Prefer web SPA if running, fall back to TUI
  const isWindows = os.platform() === 'win32'
  const webUrl = `http://localhost:5173/#${teamId}`
  let monitorMode = 'none'

  // Check if web SPA dev server is running
  let webAvailable = false
  try {
    await httpGet('http://localhost:5173', 1000)
    webAvailable = true
  } catch { /* web not running */ }

  if (webAvailable) {
    // Open browser to the SPA monitor
    const openCmd = isWindows ? 'start' : (os.platform() === 'darwin' ? 'open' : 'xdg-open')
    try {
      execSync(`${openCmd} "${webUrl}"`, { stdio: 'ignore', shell: true })
    } catch { /* browser open failed, non-fatal */ }
    monitorMode = 'web'
    log(`  ${CHECK} Monitor opened ${D}(${webUrl})${R}`)
  } else {
    // No web SPA — fall back to TUI
    const tsxBin = path.join(REPO_DIR, 'node_modules', '.bin', 'tsx')
    const monitorScript = path.join(REPO_DIR, 'cli', 'monitor.ts')
    const inTmux = !!process.env.TMUX

    if (!isWindows && inTmux) {
      try {
        execSync(
          `tmux split-window -h -l '40%' "cd '${REPO_DIR}' && '${tsxBin}' '${monitorScript}' ${teamId}"`,
          { stdio: 'ignore' }
        )
        monitorMode = 'split'
        log(`  ${CHECK} Monitor opened ${D}(right panel)${R}`)
      } catch { /* fall through */ }
    }

    if (monitorMode === 'none' && !isWindows) {
      const monitorSession = `ensemble-${teamId}`
      try {
        execSync(`tmux kill-session -t "${monitorSession}" 2>/dev/null || true`, { stdio: 'ignore' })
        execSync(
          `tmux new-session -d -s "${monitorSession}" -c "${REPO_DIR}" "'${tsxBin}' '${monitorScript}' ${teamId}"`,
          { stdio: 'ignore' }
        )
        monitorMode = 'tmux-session'
        log(`  ${CHECK} Monitor ready ${D}(tmux attach -t ${monitorSession})${R}`)
      } catch { /* fall through */ }
    }

    if (monitorMode === 'none') {
      // Print instructions — don't spawn CLI terminals when web is the primary path
      log(`  ${CHECK} Monitor: ${D}npm run dev${R} then open ${D}${webUrl}${R}`)
      monitorMode = 'manual'
    }
  }

  // ─── 5. Background poller ───
  // Replicate the bash poller: tail new lines from messages.jsonl to feed.txt
  let pollerSeen = 0
  const pollInterval = setInterval(() => {
    try {
      if (!fs.existsSync(messagesFile)) return
      const content = fs.readFileSync(messagesFile, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      if (lines.length > pollerSeen) {
        const newLines = lines.slice(pollerSeen).join('\n') + '\n'
        fs.appendFileSync(feedFile, newLines)
        pollerSeen = lines.length
      }
    } catch { /* ignore */ }
  }, 5000)
  pollInterval.unref()
  fs.writeFileSync(pollerPidFile, String(process.pid))

  // ─── 6. Wait for agents ───
  process.stdout.write(`  ${SPIN} Agents spawning...`)
  let messageCount = 0
  for (let i = 0; i < 12; i++) {
    await sleep(1000)
    try {
      const content = fs.readFileSync(messagesFile, 'utf-8')
      messageCount = content.split('\n').filter(l => l.trim()).length
      if (messageCount > 0) break
    } catch { /* ok */ }
  }

  if (messageCount > 0) {
    log(`\r  ${CHECK} Agents communicating ${D}(${messageCount} messages)${R}`)
  } else {
    log(`\r  ${SPIN} Agents warming up...       `)
  }

  // ─── Output ───
  let agentNames = 'agents'
  try {
    const teamRes = await httpGet(`${API}/api/ensemble/teams/${teamId}`)
    const team = JSON.parse(teamRes.data)
    agentNames = team.team.agents.map(a => a.name).join(' + ')
  } catch { /* ok */ }

  log('')
  log(`  ${BD}${G}Team is live!${R} ${W}${agentNames}${R} are collaborating.`)
  log('')

  if (monitorMode === 'split') {
    log(`  ${D}\u250C\u2500 Monitor (right panel) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510${R}`)
  } else {
    log(`  ${D}\u250C\u2500 Monitor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510${R}`)
    if (monitorMode === 'tmux-session') {
      log(`  ${D}\u2502${R}  ${D}tmux attach -t ensemble-${teamId}${R}      ${D}\u2502${R}`)
    }
  }
  log(`  ${D}\u2502${R}  ${W}s${R}     ${D}steer team${R}                     ${D}\u2502${R}`)
  log(`  ${D}\u2502${R}  ${W}1${R}/${W}2${R}   ${D}steer codex / claude${R}           ${D}\u2502${R}`)
  log(`  ${D}\u2502${R}  ${W}j${R}/${W}k${R}   ${D}scroll${R}                         ${D}\u2502${R}`)
  log(`  ${D}\u2502${R}  ${W}d${R}     ${D}disband team${R}                   ${D}\u2502${R}`)
  log(`  ${D}\u2502${R}  ${W}q${R}     ${D}quit monitor${R}                   ${D}\u2502${R}`)
  log(`  ${D}\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${R}`)
  log('')
}

main().catch(err => {
  console.error('Launch failed:', err.message)
  process.exit(1)
})
