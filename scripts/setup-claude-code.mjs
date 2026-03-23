#!/usr/bin/env node
/**
 * setup-claude-code.mjs — Install ensemble as /collab skill in Claude Code
 * Cross-platform replacement for setup-claude-code.sh.
 *
 * Usage: node scripts/setup-claude-code.mjs
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(__filename)
const REPO_DIR = path.resolve(SCRIPT_DIR, '..')
const isWindows = os.platform() === 'win32'

const SKILL_DIR = path.join(os.homedir(), '.claude', 'skills', 'collab')
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json')

// Colors
const G = '\x1b[92m'
const W = '\x1b[97m'
const D = '\x1b[2m'
const BD = '\x1b[1m'
const R = '\x1b[0m'
const RED = '\x1b[91m'
const YEL = '\x1b[93m'
const CHECK = `${G}\u2713${R}`
const WARN = `${YEL}\u26A0${R}`

function log(msg) { console.log(msg) }

log('')
log(`  ${BD}${W}\u25C8 ensemble \u2014 Claude Code setup${R}`)
log(`  ${D}Installing /collab skill${R}`)
log('')

// ─── 1. Install skill ───
// Pick the platform-appropriate SKILL.md
const skillSource = isWindows
  ? path.join(REPO_DIR, 'skill', 'SKILL.windows.md')
  : path.join(REPO_DIR, 'skill', 'SKILL.md')

if (!fs.existsSync(skillSource)) {
  log(`  ${RED}\u2717${R} ${path.basename(skillSource)} not found in repo`)
  process.exit(1)
}

fs.mkdirSync(SKILL_DIR, { recursive: true })

// Replace placeholders
const runtimeRoot = path.join(os.tmpdir(), 'ensemble')
let skillContent = fs.readFileSync(skillSource, 'utf-8')
  .replace(/__ENSEMBLE_DIR__/g, REPO_DIR)
  .replace(/__RUNTIME_ROOT__/g, runtimeRoot)
  .replace(/\/tmp\/ensemble/g, runtimeRoot)

fs.writeFileSync(path.join(SKILL_DIR, 'SKILL.md'), skillContent)
log(`  ${CHECK} Skill installed \u2192 ${D}${SKILL_DIR}/SKILL.md${R}`)

// ─── 2. Add permissions ───
const scriptPerms = isWindows
  ? [
      `Bash(node:*)`,
      `Bash(npx:*)`,
      `Bash(tsx:*)`,
    ]
  : [
      `Bash(${REPO_DIR}/scripts/collab-launch.sh:*)`,
      `Bash(${REPO_DIR}/scripts/collab-poll.sh:*)`,
      `Bash(${REPO_DIR}/scripts/collab-status.sh:*)`,
      `Bash(${REPO_DIR}/scripts/collab-cleanup.sh:*)`,
      `Bash(${REPO_DIR}/scripts/collab-replay.sh:*)`,
      `Bash(${REPO_DIR}/scripts/ensemble-bridge.sh:*)`,
    ]

if (fs.existsSync(SETTINGS_FILE)) {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))
  const allow = (settings.permissions ??= {}).allow ??= []
  let added = 0
  for (const perm of scriptPerms) {
    if (!allow.includes(perm)) {
      allow.push(perm)
      added++
    }
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n')
  log(added > 0
    ? `  ${CHECK} Permissions added \u2192 ${D}${SETTINGS_FILE}${R}`
    : `  ${CHECK} Permissions already configured`)
} else {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  const settings = { permissions: { allow: scriptPerms } }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n')
  log(`  ${CHECK} Settings created \u2192 ${D}${SETTINGS_FILE}${R}`)
}

// ─── 3. Check prerequisites ───
log('')

let missing = 0

function hasCommand(cmd) {
  try {
    if (isWindows) {
      execSync(`where ${cmd}`, { stdio: 'ignore' })
    } else {
      execSync(`command -v ${cmd}`, { stdio: 'ignore' })
    }
    return true
  } catch {
    return false
  }
}

if (hasCommand('node')) {
  const ver = execSync('node --version', { encoding: 'utf-8' }).trim()
  log(`  ${CHECK} Node.js ${ver}`)
} else {
  log(`  ${WARN} Node.js not found`)
  missing++
}

if (!isWindows) {
  if (hasCommand('tmux')) {
    const ver = execSync('tmux -V', { encoding: 'utf-8' }).trim().split(' ')[1] || ''
    log(`  ${CHECK} tmux ${ver}`)
  } else {
    log(`  ${WARN} tmux not found \u2014 install with: brew install tmux`)
    missing++
  }
} else {
  // On Windows, check for node-pty instead of tmux
  const ptyPath = path.join(REPO_DIR, 'node_modules', 'node-pty')
  if (fs.existsSync(ptyPath)) {
    log(`  ${CHECK} node-pty installed`)
  } else {
    log(`  ${WARN} node-pty not installed \u2014 run: npm install node-pty`)
    missing++
  }
}

let hasAgent = false
for (const cmd of ['claude', 'codex', 'aider']) {
  if (hasCommand(cmd)) {
    log(`  ${CHECK} ${cmd} CLI found`)
    hasAgent = true
  }
}
if (!hasAgent) {
  log(`  ${WARN} No agent CLI found (install claude, codex, or aider)`)
  missing++
}

// ─── 4. Check npm install ───
if (fs.existsSync(path.join(REPO_DIR, 'node_modules'))) {
  log(`  ${CHECK} npm dependencies installed`)
} else {
  log(`  ${WARN} Run 'npm install' in ${REPO_DIR}`)
  missing++
}

// ─── Done ───
log('')
if (missing === 0) {
  log(`  ${BD}${G}Setup complete!${R}`)
  log('')
  log(`  In any Claude Code session, type:`)
  log('')
  log(`    ${BD}/collab "your task description"${R}`)
  log('')
  log(`  ${D}Example: /collab "Review the auth module for security issues"${R}`)
} else {
  log(`  ${BD}${G}Skill installed${R}, but ${missing} prerequisite(s) missing.`)
  log(`  ${D}Fix the warnings above, then use /collab in Claude Code.${R}`)
}
log('')
