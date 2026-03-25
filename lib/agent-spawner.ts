/**
 * Agent Spawner — Standalone agent lifecycle management for Agent-Forge
 * Replaces ai-maestro's agent-registry + agents-core-service with a minimal implementation.
 * Handles: tmux session creation, program launching, and session cleanup.
 */

import { v4 as uuidv4 } from 'uuid'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { getRuntime } from './agent-runtime'
import { getSelfHostId } from './hosts-config'
import { buildAgentCommand, resolveAgentProgram } from './agent-config'
import { collabRuntimeDir, ensureCollabDirs } from './collab-paths'

export interface SpawnedAgent {
  id: string
  name: string
  program: string
  sessionName: string
  workingDirectory: string
  hostId: string
}

interface SpawnAgentOptions {
  name: string
  program: string
  workingDirectory: string
  hostId?: string
  teamId?: string
  apiUrl?: string
  permissionMode?: string
}

/** Compute tmux session name from agent name */
function computeSessionName(agentName: string): string {
  return agentName.replace(/[^a-zA-Z0-9\-_.]/g, '')
}

/** Resolve program name to CLI command using agents.json config */
function resolveStartCommand(program: string): string {
  return buildAgentCommand(program)
}

/**
 * Build permission flags for the agent CLI based on the permission mode.
 * Returns extra CLI flags to append to the agent command.
 */
function buildPermissionFlags(program: string, mode: string): string {
  const prog = program.toLowerCase()

  if (mode === 'full' || !mode) return '' // default — no restrictions

  if (prog.includes('claude')) {
    switch (mode) {
      case 'plan-only':
        return ' --allowedTools "Read,Grep,Glob,LS,Agent,WebSearch,WebFetch"'
      case 'review':
        return ' --allowedTools "Read,Grep,Glob,LS,Bash(git diff:*),Bash(git log:*),Bash(git show:*)"'
      case 'execute':
        return '' // full permissions — execute mode means "go ahead and write"
      default:
        return ''
    }
  }

  if (prog.includes('codex')) {
    switch (mode) {
      case 'plan-only':
        return ' -c \'sandbox_permissions=["disk-full-read-access"]\''
      case 'review':
        return ' -c \'sandbox_permissions=["disk-full-read-access"]\''
      case 'execute':
        return '' // full permissions
      default:
        return ''
    }
  }

  return '' // unknown agent — no restrictions
}

/** Absolute path to the MCP server script bundled with Agent-Forge */
function getMcpServerPath(): string {
  const __dirname = path.dirname(new URL(import.meta.url).pathname)
  // On Windows, strip leading slash from /C:/... paths
  const dir = os.platform() === 'win32' ? __dirname.replace(/^\//, '') : __dirname
  return path.join(dir, '..', 'mcp', 'agent-forge-mcp-server.mjs')
}

/**
 * Write an MCP config JSON file for an agent and return the file path.
 * The config registers the Agent-Forge MCP server with the agent's team/name/API context.
 */
function writeMcpConfig(options: {
  teamId: string
  agentName: string
  apiUrl: string
  teamDir: string
}): string {
  const mcpConfig = {
    mcpServers: {
      'agent-forge': {
        command: 'node',
        args: [getMcpServerPath()],
        env: {
          AGENT_FORGE_TEAM_ID: options.teamId,
          AGENT_FORGE_AGENT_NAME: options.agentName,
          AGENT_FORGE_API_URL: options.apiUrl,
        },
      },
    },
  }

  const configPath = path.join(options.teamDir, `${options.agentName}-mcp.json`)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2))
  console.log(`[Spawner] MCP config written to ${configPath}`)
  return configPath
}

/**
 * Spawn a local agent: create tmux session + start the AI program
 */
export async function spawnLocalAgent(options: SpawnAgentOptions): Promise<SpawnedAgent> {
  const runtime = getRuntime()
  const agentId = uuidv4()
  const sessionName = computeSessionName(options.name)
  const cwd = options.workingDirectory || process.cwd()
  const hostId = options.hostId || getSelfHostId()

  // Create session (tmux on Unix, node-pty on Windows)
  await runtime.createSession(sessionName, cwd)

  // Small delay for session init
  await new Promise(r => setTimeout(r, 300))

  // Set MCP environment variables if team context is available
  if (options.teamId) {
    const apiUrl = options.apiUrl || 'http://localhost:23000'
    await runtime.setEnvironment(sessionName, 'AGENT_FORGE_TEAM_ID', options.teamId)
    await runtime.setEnvironment(sessionName, 'AGENT_FORGE_AGENT_NAME', options.name)
    await runtime.setEnvironment(sessionName, 'AGENT_FORGE_API_URL', apiUrl)
  }

  // Build the start command, optionally with MCP config
  const startCommand = resolveStartCommand(options.program)
  let mcpFlag = ''

  // Check communication mode: "mcp" (default) or "shell" (legacy)
  const commMode = process.env.AGENT_FORGE_COMM_MODE || 'mcp'

  let mcpPreCmd = '' // command to run BEFORE the agent start (e.g. codex mcp add)

  if (options.teamId && commMode === 'mcp') {
    const agentConfig = resolveAgentProgram(options.program)
    const mcpMode = agentConfig.mcpMode

    if (mcpMode) {
      const apiUrl = options.apiUrl || 'http://localhost:23000'
      ensureCollabDirs(options.teamId)
      const teamDir = collabRuntimeDir(options.teamId)

      const shortName = options.name.includes('-')
        ? options.name.substring(options.name.indexOf('-') + 1)
        : options.name

      const mcpServerPath = getMcpServerPath()

      if (mcpMode === 'config-file') {
        // Claude Code: --mcp-config <json-file>
        const mcpConfigPath = writeMcpConfig({
          teamId: options.teamId,
          agentName: shortName,
          apiUrl,
          teamDir,
        })
        mcpFlag = ` ${agentConfig.mcpConfigFlag || '--mcp-config'} ${mcpConfigPath}`
      } else if (mcpMode === 'mcp-add') {
        // Codex: register MCP server via `codex mcp add` before launching
        const envFlags = [
          `--env AGENT_FORGE_TEAM_ID=${options.teamId}`,
          `--env AGENT_FORGE_AGENT_NAME=${shortName}`,
          `--env AGENT_FORGE_API_URL=${apiUrl}`,
        ].join(' ')
        mcpPreCmd = `codex mcp add agent-forge ${envFlags} -- node "${mcpServerPath}"`
      }
    }
  }

  // Send pre-command if needed (e.g. codex mcp add), then the agent start command
  if (mcpPreCmd) {
    await runtime.sendKeys(sessionName, mcpPreCmd, { literal: true, enter: true })
    await new Promise(r => setTimeout(r, 1000)) // wait for mcp add to complete
  }

  const permFlags = buildPermissionFlags(options.program, options.permissionMode || 'full')

  const launchCmd = os.platform() === 'win32'
    ? `set CLAUDECODE= & ${startCommand}${mcpFlag}${permFlags}`
    : `unset CLAUDECODE; ${startCommand}${mcpFlag}${permFlags}`
  await runtime.sendKeys(sessionName, launchCmd, { literal: true, enter: true })

  console.log(`[Spawner] Agent ${options.name} started in session ${sessionName}`)

  return {
    id: agentId,
    name: options.name,
    program: options.program,
    sessionName,
    workingDirectory: cwd,
    hostId,
  }
}

/**
 * Kill a local agent's tmux session
 */
export async function killLocalAgent(sessionName: string): Promise<void> {
  const runtime = getRuntime()
  try {
    // Try graceful exit first
    await runtime.sendKeys(sessionName, 'C-c', { enter: false })
    await new Promise(r => setTimeout(r, 500))
    await runtime.sendKeys(sessionName, '"exit"', { enter: true })
    await new Promise(r => setTimeout(r, 500))
    await runtime.killSession(sessionName)
  } catch {
    // Session may already be gone
    try { await runtime.killSession(sessionName) } catch { /* ok */ }
  }
}

/**
 * Spawn a remote agent via Maestro API on another machine
 */
export async function spawnRemoteAgent(
  hostUrl: string,
  agentName: string,
  program: string,
  cwd: string,
  taskDescription?: string,
  teamName?: string,
): Promise<{ id: string }> {
  // Create agent on remote host (15s timeout)
  const createCtrl = new AbortController()
  const createTimer = setTimeout(() => createCtrl.abort(), 15000)
  let createRes: Response
  try {
    createRes = await fetch(`${hostUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: agentName,
        program,
        workingDirectory: cwd,
        taskDescription,
        team: teamName,
      }),
      signal: createCtrl.signal,
    })
  } finally {
    clearTimeout(createTimer)
  }

  if (!createRes.ok) {
    const body = await createRes.text()
    throw new Error(`Remote agent create failed: ${createRes.status} ${body}`)
  }

  const { agent } = await createRes.json()

  // Wake agent on remote host (15s timeout)
  const wakeCtrl = new AbortController()
  const wakeTimer = setTimeout(() => wakeCtrl.abort(), 15000)
  try {
    const wakeRes = await fetch(`${hostUrl}/api/agents/${agent.id}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startProgram: true, sessionIndex: 0 }),
      signal: wakeCtrl.signal,
    })
    if (!wakeRes.ok) {
      const body = await wakeRes.text()
      throw new Error(`Remote agent wake failed: ${wakeRes.status} ${body}`)
    }
  } finally {
    clearTimeout(wakeTimer)
  }

  return { id: agent.id }
}

/**
 * Kill a remote agent via Maestro API
 */
export async function killRemoteAgent(hostUrl: string, agentId: string): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    await fetch(`${hostUrl}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ killSession: true }),
      signal: ctrl.signal,
    })
  } catch { /* non-fatal */ }
  finally { clearTimeout(timer) }
}

/**
 * Send command to a remote agent's session
 */
export async function postRemoteSessionCommand(
  hostUrl: string,
  sessionName: string,
  command: string,
): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const response = await fetch(`${hostUrl}/api/sessions/${encodeURIComponent(sessionName)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, requireIdle: false, addNewline: true }),
      signal: ctrl.signal,
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Remote session command failed: ${response.status} ${body}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Strip ANSI escape codes from terminal output */
function stripAnsi(str: string): string {
  // Matches: CSI sequences, OSC sequences, and other escape sequences
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[^[\]()][^\x1b]*/g, '')
}

/**
 * Scrape token usage from an agent's pane output.
 * Best-effort: returns 'unknown' if parsing fails.
 *
 * Claude Code patterns: "NNk tokens", "NN,NNN tokens", "NNN tokens"
 * Codex patterns: "NN% left", "NNk tokens"
 */
export async function getAgentTokenUsage(sessionName: string): Promise<string> {
  try {
    const runtime = getRuntime()
    const raw = await runtime.capturePane(sessionName, 100)
    // Strip ANSI escape codes so regexes match on Windows PTY output
    const output = stripAnsi(raw)

    // Claude Code: "123k tokens" or "12,345 tokens" or "1.2k tokens"
    const claudeKMatch = output.match(/(\d+(?:\.\d+)?k)\s*tokens/i)
    if (claudeKMatch) return `~${claudeKMatch[1]} tokens`

    const claudeFullMatch = output.match(/([\d,]+)\s*tokens/i)
    if (claudeFullMatch) return `~${claudeFullMatch[1]} tokens`

    // Codex: "NN% left"
    const codexPctMatch = output.match(/(\d+)%\s*left/i)
    if (codexPctMatch) return `${codexPctMatch[1]}% budget left`

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Check if a remote session exists and is ready
 */
export async function isRemoteSessionReady(hostUrl: string, sessionName: string): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const response = await fetch(`${hostUrl}/api/sessions/${encodeURIComponent(sessionName)}/command`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    })
    if (!response.ok) return false
    const body = await response.json().catch(() => null)
    return Boolean(body?.exists)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
