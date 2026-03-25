#!/usr/bin/env node
/**
 * mcp-install.mjs — Install/uninstall the Agent-Forge MCP server for Claude and Codex
 *
 * Usage:
 *   node scripts/mcp-install.mjs install claude  --team-id <id> --agent-name <name>
 *   node scripts/mcp-install.mjs install codex   --team-id <id> --agent-name <name>
 *   node scripts/mcp-install.mjs uninstall claude
 *   node scripts/mcp-install.mjs uninstall codex
 *   node scripts/mcp-install.mjs status
 */

import { execFileSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(__filename)
const REPO_DIR = path.resolve(SCRIPT_DIR, '..')
const MCP_SERVER_PATH = path.join(REPO_DIR, 'mcp', 'agent-forge-mcp-server.mjs')

// ── Colors ──────────────────────────────────────────────────────
const G = '\x1b[92m'
const R = '\x1b[0m'
const RED = '\x1b[91m'
const YEL = '\x1b[93m'
const BD = '\x1b[1m'
const D = '\x1b[2m'
const W = '\x1b[97m'
const CHECK = `${G}\u2713${R}`
const CROSS = `${RED}\u2717${R}`
const WARN = `${YEL}\u26A0${R}`

function log(msg) { console.log(msg) }

// ── Argument parsing ────────────────────────────────────────────

const args = process.argv.slice(2)
const command = args[0] // install | uninstall | status

function getFlag(name) {
  const idx = args.indexOf(name)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
}

const target = args[1] // claude | codex
const teamId = getFlag('--team-id')
const agentName = getFlag('--agent-name')
const apiUrl = getFlag('--api-url') || 'http://localhost:23000'

// ── Helpers ─────────────────────────────────────────────────────

function tryExec(cmd, cmdArgs, opts = {}) {
  try {
    return execFileSync(cmd, cmdArgs, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    }).trim()
  } catch {
    return null
  }
}

function hasCommand(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ── Install ─────────────────────────────────────────────────────

function installForClaude() {
  if (!teamId || !agentName) {
    log(`  ${CROSS} --team-id and --agent-name are required for install`)
    process.exit(1)
  }

  if (!hasCommand('claude')) {
    log(`  ${CROSS} claude CLI not found. Install it first: https://docs.anthropic.com/en/docs/claude-code`)
    process.exit(1)
  }

  // claude mcp add agent-forge --env KEY=VALUE ... -- node <path>
  const cmdArgs = [
    'mcp', 'add', 'agent-forge',
    '--env', `AGENT_FORGE_TEAM_ID=${teamId}`,
    '--env', `AGENT_FORGE_AGENT_NAME=${agentName}`,
    '--env', `AGENT_FORGE_API_URL=${apiUrl}`,
    '--', 'node', MCP_SERVER_PATH,
  ]

  log(`  Installing for Claude Code...`)
  log(`  ${D}claude ${cmdArgs.join(' ')}${R}`)

  const result = tryExec('claude', cmdArgs)
  if (result !== null) {
    log(`  ${CHECK} MCP server installed for Claude Code`)
    log(`  ${D}Team: ${teamId}, Agent: ${agentName}, API: ${apiUrl}${R}`)
  } else {
    log(`  ${CROSS} Failed to install MCP server for Claude Code`)
    log(`  ${D}Try running manually: claude ${cmdArgs.join(' ')}${R}`)
    process.exit(1)
  }
}

function installForCodex() {
  if (!teamId || !agentName) {
    log(`  ${CROSS} --team-id and --agent-name are required for install`)
    process.exit(1)
  }

  if (!hasCommand('codex')) {
    log(`  ${CROSS} codex CLI not found. Install it first: npm install -g @openai/codex`)
    process.exit(1)
  }

  // codex mcp add agent-forge --env KEY=VALUE ... -- node <path>
  const cmdArgs = [
    'mcp', 'add', 'agent-forge',
    '--env', `AGENT_FORGE_TEAM_ID=${teamId}`,
    '--env', `AGENT_FORGE_AGENT_NAME=${agentName}`,
    '--env', `AGENT_FORGE_API_URL=${apiUrl}`,
    '--', 'node', MCP_SERVER_PATH,
  ]

  log(`  Installing for Codex CLI...`)
  log(`  ${D}codex ${cmdArgs.join(' ')}${R}`)

  const result = tryExec('codex', cmdArgs)
  if (result !== null) {
    log(`  ${CHECK} MCP server installed for Codex CLI`)
    log(`  ${D}Team: ${teamId}, Agent: ${agentName}, API: ${apiUrl}${R}`)
  } else {
    log(`  ${CROSS} Failed to install MCP server for Codex CLI`)
    log(`  ${D}Try running manually: codex ${cmdArgs.join(' ')}${R}`)
    process.exit(1)
  }
}

// ── Uninstall ───────────────────────────────────────────────────

function uninstallFromClaude() {
  if (!hasCommand('claude')) {
    log(`  ${CROSS} claude CLI not found`)
    process.exit(1)
  }

  log(`  Uninstalling from Claude Code...`)
  const result = tryExec('claude', ['mcp', 'remove', 'agent-forge'])
  if (result !== null) {
    log(`  ${CHECK} MCP server removed from Claude Code`)
  } else {
    log(`  ${WARN} Could not remove — it may not be installed`)
  }
}

function uninstallFromCodex() {
  if (!hasCommand('codex')) {
    log(`  ${CROSS} codex CLI not found`)
    process.exit(1)
  }

  log(`  Uninstalling from Codex CLI...`)
  const result = tryExec('codex', ['mcp', 'remove', 'agent-forge'])
  if (result !== null) {
    log(`  ${CHECK} MCP server removed from Codex CLI`)
  } else {
    log(`  ${WARN} Could not remove — it may not be installed`)
  }
}

// ── Status ──────────────────────────────────────────────────────

function showStatus() {
  log(`  ${BD}${W}\u25C8 agent-forge MCP status${R}`)
  log(`  ${D}MCP server: ${MCP_SERVER_PATH}${R}`)
  log('')

  // Check Claude
  if (hasCommand('claude')) {
    const list = tryExec('claude', ['mcp', 'list'])
    if (list !== null && list.includes('agent-forge')) {
      log(`  ${CHECK} Claude Code: ${G}installed${R}`)
    } else {
      log(`  ${CROSS} Claude Code: not installed`)
    }
  } else {
    log(`  ${D}- Claude Code: CLI not found${R}`)
  }

  // Check Codex
  if (hasCommand('codex')) {
    const list = tryExec('codex', ['mcp', 'list'])
    if (list !== null && list.includes('agent-forge')) {
      log(`  ${CHECK} Codex CLI: ${G}installed${R}`)
    } else {
      log(`  ${CROSS} Codex CLI: not installed`)
    }
  } else {
    log(`  ${D}- Codex CLI: CLI not found${R}`)
  }
}

// ── Main ────────────────────────────────────────────────────────

log('')
log(`  ${BD}${W}\u25C8 agent-forge MCP installer${R}`)
log('')

switch (command) {
  case 'install':
    if (target === 'claude') installForClaude()
    else if (target === 'codex') installForCodex()
    else {
      log(`  ${CROSS} Unknown target: ${target}. Use 'claude' or 'codex'.`)
      process.exit(1)
    }
    break

  case 'uninstall':
    if (target === 'claude') uninstallFromClaude()
    else if (target === 'codex') uninstallFromCodex()
    else {
      log(`  ${CROSS} Unknown target: ${target}. Use 'claude' or 'codex'.`)
      process.exit(1)
    }
    break

  case 'status':
    showStatus()
    break

  default:
    log(`  Usage:`)
    log(`    node scripts/mcp-install.mjs install claude  --team-id <id> --agent-name <name>`)
    log(`    node scripts/mcp-install.mjs install codex   --team-id <id> --agent-name <name>`)
    log(`    node scripts/mcp-install.mjs uninstall claude`)
    log(`    node scripts/mcp-install.mjs uninstall codex`)
    log(`    node scripts/mcp-install.mjs status`)
    process.exit(1)
}

log('')
