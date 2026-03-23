/**
 * Ensemble Service — Standalone
 * No dependency on ai-maestro's agent-registry or agents-core-service.
 * Uses agent-spawner.ts for local/remote agent lifecycle.
 */

import { v4 as uuidv4 } from 'uuid'
import type { EnsembleTeam, EnsembleTeamAgent, EnsembleMessage, CreateTeamRequest, CollabTemplatesFile, TeamPlan, PlanStep, TeamConfig } from '../types/ensemble'
import {
  createTeam, getTeam, updateTeam, loadTeams,
  appendMessage, getMessages, deleteTeam as deleteTeamFromRegistry,
} from '../lib/ensemble-registry'
import {
  spawnLocalAgent, killLocalAgent,
  spawnRemoteAgent as spawnRemote, killRemoteAgent,
  postRemoteSessionCommand, isRemoteSessionReady,
  getAgentTokenUsage,
} from '../lib/agent-spawner'
import { isSelf, getHostById, getSelfHostId } from '../lib/hosts-config'
import { getRuntime } from '../lib/agent-runtime'
import { resolveAgentProgram } from '../lib/agent-config'
import { AgentWatchdog } from '../lib/agent-watchdog'
import {
  collabPromptFile, collabDeliveryFile, collabSummaryFile,
  collabRuntimeDir, collabFinishedMarker, collabBridgePosted,
  collabBridgeResult, ensureCollabDirs,
} from '../lib/collab-paths'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createWorktree, mergeWorktree, destroyWorktree, type WorktreeInfo } from '../lib/worktree-manager'
import { runStagedWorkflow } from '../lib/staged-workflow'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface ServiceResult<T> {
  data?: T
  error?: string
  status: number
}

const IDLE_CHECK_INTERVAL_MS = 15_000
const COMPLETION_SIGNAL_WINDOW_MS = 60_000
const SINGLE_SIGNAL_IDLE_THRESHOLD_MS = 120_000
const COMPLETION_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_])afgerond(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])done(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])complete(?:d)?(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])klaar(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|\s)tot de volgende(?:\s|$)/i,
]

interface CompletionSignal {
  agentName: string
  timestamp: number
}
// Telegram notifications: set both env vars to enable, omit to disable
const TELEGRAM_BOT_TOKEN = process.env.ENSEMBLE_TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_ID = process.env.ENSEMBLE_TELEGRAM_CHAT_ID || ''

class EnsembleService {
  private readonly disbandingTeams = new Set<string>()
  private readonly idleCheckTimer: NodeJS.Timeout
  private readonly watchdog: AgentWatchdog

  constructor() {
    this.idleCheckTimer = setInterval(() => {
      void this.checkIdleTeams()
    }, IDLE_CHECK_INTERVAL_MS)
    this.idleCheckTimer.unref()
    this.watchdog = new AgentWatchdog({
      loadTeams,
      getMessages: (teamId: string) => getMessages(teamId),
      appendMessage,
      getRuntime,
      resolveAgentProgram,
      isSelf: (hostId?: string) => isSelf(hostId || ''),
      getHostById,
      postRemoteSessionCommand,
      collabDeliveryFile,
    })

    for (const signal of ['SIGINT', 'SIGTERM', 'beforeExit', 'exit'] as const) {
      process.once(signal, () => this.stop())
    }
  }

  async checkIdleTeams(): Promise<void> {
    const teams = loadTeams().filter(team => team.status === 'active')

    for (const team of teams) {
      if (this.disbandingTeams.has(team.id)) continue

      // Check maxTurns limit
      const maxTurns = team.config?.maxTurns
      if (maxTurns && maxTurns > 0) {
        const messages = getMessages(team.id)
        const nonEnsembleMessages = messages.filter(m => m.from !== 'ensemble')
        if (nonEnsembleMessages.length >= maxTurns) {
          this.disbandingTeams.add(team.id)
          try {
            appendMessage(team.id, {
              id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `Auto-disband triggered: max turns reached (${nonEnsembleMessages.length}/${maxTurns})`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
            await writeDisbandSummary(team.id)
            await disbandTeam(team.id, 'auto')
          } catch (err) {
            console.error(`[Ensemble] Auto-disband (maxTurns) failed for ${team.id}:`, err)
          } finally {
            this.disbandingTeams.delete(team.id)
          }
          continue
        }
      }

      // Check runtime timeout
      const timeoutMs = team.config?.timeoutMs
      if (timeoutMs && timeoutMs > 0) {
        const elapsed = Date.now() - new Date(team.createdAt).getTime()
        if (elapsed >= timeoutMs) {
          this.disbandingTeams.add(team.id)
          try {
            appendMessage(team.id, {
              id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `Auto-disband triggered: runtime timeout reached (${Math.round(elapsed / 60000)}min / ${Math.round(timeoutMs / 60000)}min)`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
            await writeDisbandSummary(team.id)
            await disbandTeam(team.id, 'auto')
          } catch (err) {
            console.error(`[Ensemble] Auto-disband (timeout) failed for ${team.id}:`, err)
          } finally {
            this.disbandingTeams.delete(team.id)
          }
          continue
        }
      }

      if (!this.shouldAutoDisband(team)) continue

      this.disbandingTeams.add(team.id)

      try {
        appendMessage(team.id, {
          id: uuidv4(),
          teamId: team.id,
          from: 'ensemble',
          to: 'team',
          content: 'Auto-disband triggered after 60s idle and completion-like agent messages',
          type: 'chat',
          timestamp: new Date().toISOString(),
        })

        await writeDisbandSummary(team.id)
        await disbandTeam(team.id, 'auto')
      } catch (err) {
        console.error(`[Ensemble] Auto-disband failed for ${team.id}:`, err)
      } finally {
        this.disbandingTeams.delete(team.id)
      }
    }
  }

  private shouldAutoDisband(team: EnsembleTeam): boolean {
    const messages = getMessages(team.id)
    const nonEnsembleMessages = messages.filter(message => message.from !== 'ensemble')
    const lastMessage = nonEnsembleMessages[nonEnsembleMessages.length - 1]
    if (!lastMessage) return false

    // Robust timestamp handling: skip idle check if no timestamp available
    const lastTimestamp = lastMessage.timestamp
      ? new Date(lastMessage.timestamp).getTime()
      : NaN
    if (Number.isNaN(lastTimestamp)) return false

    const activeAgents = team.agents.filter(agent => agent.status === 'active')
    if (activeAgents.length === 0) return false

    // Use per-team config with fallback to module-level defaults
    const completionWindowMs = team.config?.completionWindowMs ?? COMPLETION_SIGNAL_WINDOW_MS
    const singleSignalIdleMs = team.config?.singleSignalIdleMs ?? SINGLE_SIGNAL_IDLE_THRESHOLD_MS

    const idleForMs = Date.now() - lastTimestamp
    const activeAgentNames = new Set(activeAgents.map(agent => agent.name))
    const completionSignals = messages
      .filter(message => activeAgentNames.has(message.from) && this.hasCompletionSignal(message.content))
      .map(message => ({
        agentName: message.from,
        timestamp: message.timestamp ? new Date(message.timestamp).getTime() : NaN,
      }))
      .filter((signal): signal is CompletionSignal => !Number.isNaN(signal.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp)

    if (this.hasTwoRecentCompletionSignals(completionSignals, completionWindowMs)) return true
    if (idleForMs <= singleSignalIdleMs) return false
    return completionSignals.length >= 1
  }

  private hasCompletionSignal(content: string): boolean {
    return COMPLETION_PATTERNS.some(pattern => pattern.test(content))
  }

  private hasTwoRecentCompletionSignals(signals: CompletionSignal[], windowMs: number = COMPLETION_SIGNAL_WINDOW_MS): boolean {
    for (let i = 0; i < signals.length; i++) {
      for (let j = i + 1; j < signals.length; j++) {
        if (signals[j].timestamp - signals[i].timestamp > windowMs) break
        if (signals[i].agentName !== signals[j].agentName) return true
      }
    }
    return false
  }

  private stop(): void {
    clearInterval(this.idleCheckTimer)
    this.watchdog.stop()
  }
}

const ensembleService = new EnsembleService()

function formatDuration(durationMs: number): string {
  const durationMin = Math.max(0, Math.round(durationMs / 60000))
  return durationMin >= 60
    ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
    : `${durationMin}m`
}

/** Escape special chars for Telegram MarkdownV2 */
function escMd(s: string): string {
  return s.replace(/([_[\]()~`>#+\-=|{}.!*\\])/g, '\\$1')
}

function sendTelegramSummary(params: {
  task: string
  duration: string
  messageCount: number
  agentSummaries: { name: string; msgs: number; tokens: string }[]
}): void {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return

  const agents = params.agentSummaries
  const agentLine = agents.map(a => `${escMd(a.name)} \\(${a.msgs}, ${escMd(a.tokens)}\\)`).join(' \\+ ')

  const text = [
    `\u2728 *Collab klaar* \u2014 ${escMd(params.duration)}, ${params.messageCount} msgs`,
    escMd(params.task.slice(0, 100)),
    agentLine,
  ].join('\n')

  // Use native fetch (Node 18+) instead of curl for cross-platform support
  const body = new URLSearchParams({
    chat_id: TELEGRAM_CHAT_ID,
    parse_mode: 'MarkdownV2',
    text,
  })

  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }).catch(err => {
    console.error('[Ensemble] Telegram notification failed:', err)
  })
}

async function routeToHost(_program: string, preferredHostId?: string): Promise<string> {
  if (preferredHostId) {
    const host = getHostById(preferredHostId)
    if (host) return preferredHostId
    console.warn(`[Ensemble] Unknown host ${preferredHostId}, falling back to self`)
  }
  return getSelfHostId()
}

export function loadCollabTemplate(templateName?: string): CollabTemplatesFile['templates'][string] | undefined {
  if (!templateName) return undefined
  try {
    const templatesPath = path.join(__dirname, '..', 'collab-templates.json')
    const raw = fs.readFileSync(templatesPath, 'utf-8')
    const data: CollabTemplatesFile = JSON.parse(raw)
    const template = data.templates[templateName]
    if (!template) {
      console.warn(`[Ensemble] Unknown template "${templateName}", falling back to default roles`)
      return undefined
    }
    console.log(`[Ensemble] Loaded template "${templateName}" (${template.name})`)
    return template
  } catch (err) {
    console.warn(`[Ensemble] Failed to load templates:`, err)
    return undefined
  }
}

export interface CollabTemplateSummary {
  id: string
  name: string
  description: string
  suggestedTaskPrefix: string
  roles: string[]
}

export function listCollabTemplates(): CollabTemplateSummary[] {
  try {
    const templatesPath = path.join(__dirname, '..', 'collab-templates.json')
    const raw = fs.readFileSync(templatesPath, 'utf-8')
    const data: CollabTemplatesFile = JSON.parse(raw)

    return Object.entries(data.templates).map(([id, template]) => ({
      id,
      name: template.name,
      description: template.description,
      suggestedTaskPrefix: template.suggestedTaskPrefix,
      roles: template.roles.map(role => role.role),
    }))
  } catch (err) {
    console.warn('[Ensemble] Failed to list templates:', err)
    return []
  }
}

export function buildPromptPreview(params: {
  teamId: string
  teamName: string
  description: string
  agentName: string
  teammateNames: string[]
  agentIndex: number
  templateName?: string
  useMcp?: boolean
  permissionMode?: string
}): string {
  const template = loadCollabTemplate(params.templateName)

  // Shell command fallback (used when MCP is not available)
  const scriptsDir = path.join(__dirname, '..', 'scripts')
  const isWindows = os.platform() === 'win32'
  const teamSayCmd = isWindows
    ? `node ${scriptsDir}\\team-say.mjs ${params.teamId} ${params.agentName} ${params.teammateNames[0] || 'team'}`
    : `${scriptsDir}/team-say.sh ${params.teamId} ${params.agentName} ${params.teammateNames[0] || 'team'}`
  const teamReadCmd = isWindows
    ? `node ${scriptsDir}\\team-read.mjs ${params.teamId}`
    : `${scriptsDir}/team-read.sh ${params.teamId}`

  let roleInstructions: string[]

  if (template && params.agentIndex < template.roles.length) {
    const templateRole = template.roles[params.agentIndex]
    roleInstructions = [
      `ROLE: ${templateRole.role}.`,
      templateRole.focus,
    ]
  } else {
    const isLead = params.agentIndex === 0
    const roleName = isLead ? 'LEAD' : 'WORKER'
    roleInstructions = isLead
      ? [
          `ROLE: ${roleName}.`,
          `You own architecture, planning, high-level design, task breakdown, and code review.`,
          `Your first action after greeting is to share a concrete implementation plan with the worker before any implementation starts.`,
          `Keep the worker focused by delegating clear implementation steps, reviewing progress, and calling out risks or design corrections early.`,
        ]
      : [
          `ROLE: ${roleName}.`,
          `You own implementation, writing code, running tests, and reporting concrete execution progress.`,
          `After greeting, wait for the lead's plan before starting implementation work.`,
          `Once the lead shares a plan, execute it pragmatically, report what you changed, and surface blockers or test failures quickly.`,
        ]
  }

  // Communication instructions depend on whether MCP tools are available
  const commInstructions = params.useMcp
    ? [
        `COMMUNICATION: You have MCP tools: team_say, team_read, team_done, team_plan, team_status. Use them directly — do NOT use shell commands.`,
        `1. IMMEDIATELY greet your teammate with team_say — do this FIRST before any reading or analysis.`,
        `2. Communicate FREQUENTLY — share progress every 1-2 minutes, not just when done.`,
        `3. After EVERY team_say, run team_read to check for responses.`,
        `4. If teammate shared findings, RESPOND to them before continuing your own work.`,
        `5. When your work is COMPLETE, call team_done with a summary. Do NOT keep saying "standing by" or "waiting" — call team_done instead.`,
        `6. To share a structured plan, use team_plan with an array of steps.`,
      ]
    : [
        // Fallback: shell command instructions (backward compat when MCP is not configured)
        `COMMUNICATION RULES:`,
        `1. IMMEDIATELY greet your teammate with team-say — do this FIRST before any reading or analysis.`,
        `2. Send findings: ${teamSayCmd} "your message"`,
        `3. Read teammate messages: ${teamReadCmd}`,
        `4. Communicate FREQUENTLY — share progress every 1-2 minutes, not just when done.`,
        `5. After EVERY team-say, run team-read to check for responses.`,
        `6. If teammate shared findings, RESPOND to them before continuing your own work.`,
        `7. Keep alternating: greet, plan, analyze, share, read, respond, analyze.`,
      ]

  // Permission mode instructions
  const permInstructions: string[] = []
  switch (params.permissionMode) {
    case 'plan-only':
      permInstructions.push(
        `PERMISSION MODE: PLAN ONLY.`,
        `You may ONLY read, analyze, and discuss. Do NOT edit files, write code, or run mutating commands.`,
        `Your output should be plans, analysis, and recommendations — not implementation.`,
      )
      break
    case 'review':
      permInstructions.push(
        `PERMISSION MODE: REVIEW.`,
        `You may ONLY read code, run git diff/log/show, and communicate findings.`,
        `Do NOT edit files, create files, or run any mutating commands. Report issues only.`,
      )
      break
    case 'execute':
      permInstructions.push(
        `PERMISSION MODE: EXECUTE.`,
        `Follow the plan precisely. Write code, run tests, make changes as specified.`,
        `Do NOT deviate from the plan without communicating the reason first.`,
      )
      break
    // 'full' or undefined — no restrictions
  }

  return [
    `You are ${params.agentName} in team "${params.teamName}" with teammate ${params.teammateNames.join(', ')}.`,
    `Task: ${params.description}`,
    ...permInstructions,
    ...roleInstructions,
    ...commInstructions,
    `START NOW: Run team${params.useMcp ? '_say' : '-say'} to greet your teammate, then begin work.`,
  ].join(' ')
}

export async function createEnsembleTeam(
  request: CreateTeamRequest
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const team = createTeam(request)

  // Return immediately with the team in "forming" state.
  // Spawn agents in the background (no await) so the HTTP response is not blocked.
  void spawnTeamAgents(team, request)

  return { data: { team }, status: 201 }
}

/**
 * Add a new agent to an already-running team.
 * The agent gets MCP configured, receives recent message context, and joins mid-collaboration.
 */
export async function addAgentToTeam(
  teamId: string,
  program: string,
  role?: string,
): Promise<ServiceResult<{ agent: EnsembleTeamAgent }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  if (team.status !== 'active' && team.status !== 'forming') {
    return { error: 'Can only add agents to active teams', status: 400 }
  }

  // Determine agent name (program-N where N is next available number)
  const programBase = program.toLowerCase().replace(/\s+/g, '-').split('-')[0]
  const existingNumbers = team.agents
    .filter(a => a.program === program || a.name.startsWith(programBase))
    .map(a => {
      const parts = a.name.split('-')
      return parseInt(parts[parts.length - 1] || '0', 10)
    })
  const nextNum = Math.max(0, ...existingNumbers) + 1
  const shortName = `${programBase}-${nextNum}`

  const agentName = `${team.name}-${shortName}`
  const cwd = team.agents[0]?.worktreePath || process.cwd()

  // Build prompt with team context — include recent messages so the new agent has context
  const otherNames = team.agents.map(a => a.name)
  const prompt = buildPromptPreview({
    teamId: team.id,
    teamName: team.name,
    description: team.description,
    agentName: shortName,
    teammateNames: otherNames,
    agentIndex: team.agents.length, // worker role
    useMcp: (process.env.ENSEMBLE_COMM_MODE || 'mcp') === 'mcp',
    permissionMode: team.config?.permissionMode,
  })

  // Add recent message context to the prompt so the agent can catch up
  const recentMessages = getMessages(teamId).slice(-10)
  const contextSummary = recentMessages
    .filter(m => m.from !== 'ensemble')
    .map(m => `${m.from}: ${m.content.slice(0, 200)}`)
    .join('\n')
  const fullPrompt = `${prompt}\n\nCATCH-UP CONTEXT — here are the last messages from the team:\n${contextSummary}\n\nYou are joining mid-conversation. Read the context above, greet the team, and contribute.`

  const apiUrl = process.env.ENSEMBLE_URL || 'http://localhost:23000'

  // Spawn the agent
  try {
    const spawned = await spawnLocalAgent({
      name: agentName,
      program,
      workingDirectory: cwd,
      teamId: team.id,
      apiUrl,
      permissionMode: team.config?.permissionMode,
    })

    // Build the new agent record
    const newAgent: EnsembleTeamAgent = {
      agentId: spawned.id,
      name: shortName,
      program,
      role: role || 'worker',
      hostId: spawned.hostId,
      status: 'active',
    }
    team.agents.push(newAgent)
    updateTeam(teamId, { agents: team.agents })

    // Announce
    appendMessage(teamId, {
      id: uuidv4(), teamId, from: 'ensemble', to: 'team',
      content: `${shortName} (${program}) has joined the team`,
      type: 'chat', timestamp: new Date().toISOString(),
    })

    // Wait for ready, then inject prompt (run in background)
    void (async () => {
      const runtime = getRuntime()
      const agentConfig = resolveAgentProgram(program)

      // Wait for ready
      const start = Date.now()
      while (Date.now() - start < 60000) {
        try {
          const output = await runtime.capturePane(spawned.sessionName, 50)
          if (output.includes(agentConfig.readyMarker)) break
        } catch { /* not ready yet */ }
        await new Promise(r => setTimeout(r, 1000))
      }
      await new Promise(r => setTimeout(r, 2000))

      // Inject prompt
      const promptFile = collabPromptFile(teamId, shortName)
      ensureCollabDirs(teamId)
      fs.writeFileSync(promptFile, fullPrompt)
      if (agentConfig.inputMethod === 'pasteFromFile') {
        await runtime.pasteFromFile(spawned.sessionName, promptFile)
      } else {
        await runtime.sendKeys(spawned.sessionName, fullPrompt, { literal: true, enter: true })
      }
    })()

    return { data: { agent: newAgent }, status: 201 }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: `Failed to spawn agent: ${message}`, status: 500 }
  }
}

/**
 * Background worker that handles the heavy lifting after a team is created:
 *   Phase 0 — create worktrees (optional)
 *   Phase 1 — spawn agents
 *   Phase 2 — wait for agents to be ready
 *   Phase 3 — inject prompts (or kick off staged workflow)
 *
 * The team transitions to "active" on success or "disbanded" if all agents fail.
 * Progress is reported via the team message feed so SSE/polling clients stay informed.
 */
async function spawnTeamAgents(team: EnsembleTeam, request: CreateTeamRequest): Promise<void> {
  try {
    const cwd = request.workingDirectory || process.cwd()
    const worktreeMap = new Map<string, WorktreeInfo>()

    // Phase 0: Create worktrees for local agents if requested
    if (request.useWorktrees) {
      for (let i = 0; i < team.agents.length; i++) {
        const agentSpec = team.agents[i]
        const hostId = request.agents[i].hostId
          ? (getHostById(request.agents[i].hostId!) ? request.agents[i].hostId! : getSelfHostId())
          : getSelfHostId()

        // Only create worktrees for local agents
        if (isSelf(hostId)) {
          try {
            const worktreeInfo = await createWorktree(team.id, agentSpec.name, cwd)
            worktreeMap.set(agentSpec.name, worktreeInfo)
            team.agents[i].worktreePath = worktreeInfo.path
            team.agents[i].worktreeBranch = worktreeInfo.branch
            appendMessage(team.id, {
              id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `🌳 Worktree created for ${agentSpec.name}: ${worktreeInfo.branch}`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            console.error(`[Ensemble] Failed to create worktree for ${agentSpec.name}:`, message)
            appendMessage(team.id, {
              id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `⚠️ Worktree creation failed for ${agentSpec.name}: ${message}. Using shared directory.`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
          }
        }
      }
    }

    const apiUrl = process.env.ENSEMBLE_URL || 'http://localhost:23000'

    const buildPrompt = (agentName: string, otherNames: string[], agentIndex: number) => {
      return buildPromptPreview({
        teamId: team.id,
        teamName: team.name,
        description: team.description,
        agentName,
        teammateNames: otherNames,
        agentIndex,
        templateName: request.templateName,
        useMcp: (process.env.ENSEMBLE_COMM_MODE || 'mcp') === 'mcp',
        permissionMode: team.config?.permissionMode,
      })
    }

    // Phase 1: Spawn all agents
    for (let i = 0; i < team.agents.length; i++) {
      const agentSpec = team.agents[i]
      const hostId = await routeToHost(agentSpec.program, request.agents[i].hostId)
      const agentName = `${team.name}-${agentSpec.name}`
      const prompt = buildPrompt(agentSpec.name, team.agents.filter((_, j) => j !== i).map(a => a.name), i)

      ensureCollabDirs(team.id)
      const promptFile = collabPromptFile(team.id, agentSpec.name)
      fs.writeFileSync(promptFile, prompt)
      console.log(`[Ensemble] Prompt for ${agentSpec.name}: ${prompt}`)

      try {
        let agentId: string
        console.log(`[Ensemble] Spawning ${agentName} (${agentSpec.program}) on ${hostId} (self=${isSelf(hostId)})`)

        if (isSelf(hostId)) {
          const agentCwd = worktreeMap.get(agentSpec.name)?.path || cwd
          const spawned = await spawnLocalAgent({
            name: agentName,
            program: agentSpec.program,
            workingDirectory: agentCwd,
            hostId,
            teamId: team.id,
            apiUrl,
            permissionMode: team.config?.permissionMode,
          })
          agentId = spawned.id
        } else {
          const host = getHostById(hostId)
          if (!host) throw new Error(`Unknown host: ${hostId}`)
          const remote = await spawnRemote(host.url, agentName, agentSpec.program, cwd, team.description, team.name)
          agentId = remote.id
        }

        team.agents[i].agentId = agentId
        team.agents[i].hostId = hostId
        team.agents[i].status = 'active'

        appendMessage(team.id, {
          id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `${agentSpec.name} (${agentSpec.program} @ ${hostId}) has joined #${team.name}`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[Ensemble] Failed to spawn ${agentName}:`, message)
        team.agents[i].status = 'idle'
        appendMessage(team.id, {
          id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `Failed to spawn ${agentName}: ${message}`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      }
    }

    // Check if ALL agents failed — if so, mark team as disbanded
    const activeAgents = team.agents.filter(a => a.status === 'active')
    if (activeAgents.length === 0) {
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `❌ All agents failed to spawn — team disbanded`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
      updateTeam(team.id, { ...team, status: 'disbanded', completedAt: new Date().toISOString() })
      return
    }

    updateTeam(team.id, { ...team, status: 'active' })

    // Phase 2: Wait for ALL agents to be ready, then inject prompts
    if (activeAgents.length >= 2) {
      const runtime = getRuntime()

      const waitForReady = async (
        sessionName: string, program: string, hostId?: string, maxWait = 60000,
      ): Promise<boolean> => {
        const start = Date.now()
        const agentConfig = resolveAgentProgram(program)
        const readyMarker = agentConfig.readyMarker
        while (Date.now() - start < maxWait) {
          try {
            if (hostId && !isSelf(hostId)) {
              const host = getHostById(hostId)
              if (host && await isRemoteSessionReady(host.url, sessionName)) {
                console.log(`[Ensemble] ${sessionName} is remotely reachable (${Math.round((Date.now() - start) / 1000)}s)`)
                return true
              }
            } else {
              const output = await runtime.capturePane(sessionName, 50)
              if (output.includes(readyMarker)) {
                console.log(`[Ensemble] ${sessionName} is ready (${Math.round((Date.now() - start) / 1000)}s)`)
                return true
              }
            }
          } catch { /* not ready yet */ }
          await new Promise(r => setTimeout(r, 1000))
        }
        console.error(`[Ensemble] ${sessionName} did not become ready within ${maxWait / 1000}s`)
        return false
      }

      console.log(`[Ensemble] Waiting for all ${activeAgents.length} agents to be ready...`)
      const readyResults = await Promise.all(
        activeAgents.map(agent => {
          const sessionName = `${team.name}-${agent.name}`
          return waitForReady(sessionName, agent.program, agent.hostId).then(ready => ({ agent, sessionName, ready }))
        })
      )

      const ready = readyResults.filter(r => r.ready)
      const notReady = readyResults.filter(r => !r.ready)

      for (const nr of notReady) {
        appendMessage(team.id, {
          id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `❌ ${nr.agent.name} failed to start — timed out`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      }

      if (ready.length < 2) {
        appendMessage(team.id, {
          id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `❌ Team start aborted: only ${ready.length}/${activeAgents.length} agents ready`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
        return
      }

      await new Promise(r => setTimeout(r, 2000))

      // Phase 3: Inject prompts (skip if staged — staged workflow handles its own prompts)
      if (request.staged) {
        // Staged mode: skip normal prompt injection, run plan→exec→verify workflow
        appendMessage(team.id, {
          id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `🚀 All ${ready.length} agents ready — starting staged workflow (plan → exec → verify)`,
          type: 'chat', timestamp: new Date().toISOString(),
        })

        const buildStagedPlanPrompt = (agentName: string, otherNames: string[], agentIndex: number): string => [
          buildPrompt(agentName, otherNames, agentIndex),
          `STAGED WORKFLOW MODE.`,
          `PHASE 1 PLAN: ONLY create and share a plan via team-say.`,
          `Do NOT write code, edit files, or run mutating commands yet.`,
          `Both agents must share their plan before implementation begins.`,
          `After sharing your plan, run team-read and align on the execution approach.`,
        ].join(' ')

        const buildStagedExecPrompt = (otherNames: string[]): string => [
          `PHASE 2 EXEC: Planning is complete.`,
          `You may now execute the agreed plan and make code changes.`,
          `Share concrete progress via team-say and explicitly report when your implementation is done.`,
          `Keep coordinating with ${otherNames.join(', ')} as you work.`,
        ].join(' ')

        const buildStagedVerifyPrompt = (teammateToReview?: string): string => [
          `PHASE 3 VERIFY: Review ${teammateToReview || 'your teammate'}'s work.`,
          `Inspect what they changed, compare it against the plan, and report findings via team-say.`,
          `Focus on bugs, regressions, missing tests, and mismatches with the agreed approach.`,
        ].join(' ')

        // Run in background (fire-and-forget within the already-background spawnTeamAgents)
        runStagedWorkflow(team, request.stagedConfig, {
          buildPlanPrompt: ({ agent, teammates, index }) => buildStagedPlanPrompt(agent.name, teammates, index),
          buildExecPrompt: ({ teammates }) => buildStagedExecPrompt(teammates),
          buildVerifyPrompt: ({ teammateToReview }) => buildStagedVerifyPrompt(teammateToReview),
        }).catch(err => {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[Ensemble] Staged workflow failed for ${team.id}:`, message)
          appendMessage(team.id, {
            id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
            content: `❌ Staged workflow failed: ${message}`,
            type: 'chat', timestamp: new Date().toISOString(),
          })
        })
      } else {
        // Normal mode: inject prompts simultaneously
        console.log(`[Ensemble] All ${ready.length} agents ready — injecting prompts simultaneously`)
        await Promise.all(
          ready.map(async ({ agent, sessionName }) => {
            const promptFile = collabPromptFile(team.id, agent.name)
            try {
              if (agent.hostId && !isSelf(agent.hostId)) {
                const host = getHostById(agent.hostId)
                if (host) {
                  const prompt = fs.readFileSync(promptFile, 'utf-8')
                  await postRemoteSessionCommand(host.url, sessionName, prompt)
                }
              } else {
                const agentCfg = resolveAgentProgram(agent.program)
                if (agentCfg.inputMethod === 'pasteFromFile') {
                  await runtime.pasteFromFile(sessionName, promptFile)
                } else {
                  const prompt = fs.readFileSync(promptFile, 'utf-8')
                  await runtime.sendKeys(sessionName, prompt, { literal: true, enter: true })
                }
              }
              console.log(`[Ensemble] ✓ Prompt injected into ${sessionName}`)
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              appendMessage(team.id, {
                id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
                content: `❌ Delivery to ${agent.name} failed: ${message}`,
                type: 'chat', timestamp: new Date().toISOString(),
              })
              console.error(`[Ensemble] ✗ Failed to inject prompt into ${sessionName}:`, err)
            }
          })
        )

        appendMessage(team.id, {
          id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `🚀 All ${ready.length} agents received their task — collaboration started`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      }
    }
  } catch (err: unknown) {
    // Top-level catch: if something unexpected blows up, mark team as failed
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[Ensemble] spawnTeamAgents failed for ${team.id}:`, message)
    appendMessage(team.id, {
      id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
      content: `❌ Team setup failed: ${message}`,
      type: 'chat', timestamp: new Date().toISOString(),
    })
    updateTeam(team.id, { status: 'disbanded', completedAt: new Date().toISOString() })
  }
}

export function getEnsembleTeam(teamId: string): ServiceResult<{ team: EnsembleTeam; messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  return { data: { team, messages: getMessages(teamId) }, status: 200 }
}

export function listEnsembleTeams(): ServiceResult<{ teams: EnsembleTeam[] }> {
  return { data: { teams: loadTeams() }, status: 200 }
}

export async function checkIdleTeams(): Promise<void> {
  await ensembleService.checkIdleTeams()
}

export function getTeamFeed(teamId: string, since?: string): ServiceResult<{ messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  return { data: { messages: getMessages(teamId, since) }, status: 200 }
}

/**
 * Detect a numbered plan/step list in message content.
 * Returns a TeamPlan if at least 3 numbered steps are found, otherwise null.
 */
export function detectPlan(content: string, messageId: string): TeamPlan | null {
  // Match patterns: "1. ", "1) ", "Step 1:", "Phase 1:"
  const stepPattern = /^[ \t]*(?:(?:step|phase)\s+)?(\d+)[.):\s]\s*(.+)/gim
  const steps: PlanStep[] = []
  let match: RegExpExecArray | null

  while ((match = stepPattern.exec(content)) !== null) {
    const stepText = match[2].trim()
    // Skip empty or very short step text (likely not a real step)
    if (stepText.length < 3) continue
    steps.push({
      id: `${messageId}-step-${steps.length}`,
      index: steps.length,
      text: stepText,
      status: 'pending',
    })
  }

  // Require at least 3 steps to count as a plan
  if (steps.length < 3) return null

  return {
    steps,
    sourceMessageId: messageId,
    detectedAt: new Date().toISOString(),
    version: 1,
  }
}

export async function sendTeamMessage(
  teamId: string, to: string, content: string, from?: string,
  existingId?: string, existingTimestamp?: string,
): Promise<ServiceResult<{ message: EnsembleMessage }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

  const message: EnsembleMessage = {
    id: existingId || uuidv4(), teamId, from: from || 'user', to, content,
    type: 'chat', timestamp: existingTimestamp || new Date().toISOString(),
  }
  appendMessage(teamId, message)

  // Detect plan in non-ensemble messages
  const sender = from || 'user'
  if (sender !== 'ensemble') {
    const detectedPlan = detectPlan(content, message.id)
    if (detectedPlan) {
      const existingPlan = team.plan
      // Check if sender is a lead agent (first agent or role includes 'lead')
      const senderAgent = team.agents.find(a => a.name === sender)
      const isLead = senderAgent && (
        senderAgent === team.agents[0] ||
        senderAgent.role.toLowerCase().includes('lead')
      )
      // Update plan if new one has more steps or is from a lead agent
      const shouldUpdate = !existingPlan ||
        detectedPlan.steps.length > existingPlan.steps.length ||
        isLead
      if (shouldUpdate) {
        const version = existingPlan ? existingPlan.version + 1 : 1
        updateTeam(teamId, { plan: { ...detectedPlan, version } })
      }
    }
  }

  // Determine which agents should receive this message in their tmux pane
  const recipients = to === 'team'
    ? team.agents.filter(a => a.status === 'active' && a.name !== sender)
    : team.agents.filter(a => a.status === 'active' && a.name === to)

  const runtime = getRuntime()

  for (const targetAgent of recipients) {
    try {
      const sessionName = `${team.name}-${targetAgent.name}`

      // Skip delivery if the agent's tmux pane no longer exists (agent finished and exited)
      const paneAlive = await runtime.sessionExists(sessionName)
      if (!paneAlive) continue

      // Wrap message with sender context + response nudge
      const deliveryText = [
        `[Team message from ${sender}]: ${content}`,
        `→ Respond with team-say. Then run team-read to check for more messages.`,
      ].join('\n')

      if (targetAgent.hostId && !isSelf(targetAgent.hostId)) {
        const host = getHostById(targetAgent.hostId)
        if (host) await postRemoteSessionCommand(host.url, sessionName, deliveryText)
      } else {
        // Always use pasteFromFile for message delivery to avoid shell escaping issues
        // (sendKeys breaks on ?, !, \ and other special chars in zsh)
        const tmpFile = collabDeliveryFile(teamId, sessionName)
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
        fs.writeFileSync(tmpFile, deliveryText)
        await runtime.pasteFromFile(sessionName, tmpFile)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: `❌ Delivery to ${targetAgent.name} failed: ${reason}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
  }

  return { data: { message }, status: 200 }
}

/**
 * Write a summary file for a disbanded team — used by auto-disband and can be
 * picked up by the background watcher in the Claude Code session.
 * Mirrors the format from cli/monitor.ts disbandTeam().
 */
export async function writeDisbandSummary(teamId: string): Promise<void> {
  const team = getTeam(teamId)
  if (!team) return

  const messages = getMessages(teamId)
  const agentMsgs = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')
  if (agentMsgs.length === 0) return

  const now = new Date()
  const createdAt = new Date(team.createdAt)
  const durationMs = now.getTime() - createdAt.getTime()
  const duration = formatDuration(durationMs)

  const agents = [...new Set(agentMsgs.map(m => m.from))]

  // Scrape token usage from each agent's tmux pane (best-effort)
  const tokenUsageMap: Record<string, string> = {}
  await Promise.all(
    team.agents
      .filter(a => a.status === 'active')
      .map(async (agent) => {
        const sessionName = `${team.name}-${agent.name}`
        tokenUsageMap[agent.name] = await getAgentTokenUsage(sessionName)
      })
  )

  const stripPaths = (s: string) =>
    s.replace(/(?:\/tmp\/ensemble|[A-Z]:\\[^"'\s]*\\Temp\\ensemble)[-\w\\]*/gi, '').trim()

  const summaryText = agents.map(agent => {
    const msgs = agentMsgs.filter(m => m.from === agent)
    const tokens = tokenUsageMap[agent] || 'unknown'
    const lastThree = msgs.slice(-3).map((m, i) => {
      const cleaned = stripPaths(m.content)
      return `  [${msgs.length - (msgs.slice(-3).length - 1 - i)}/${msgs.length}]: ${cleaned.slice(0, 500)}`
    })
    return `${agent} (${msgs.length} msgs, tokens: ${tokens}):\n${lastThree.join('\n')}`
  }).join('\n\n')

  // Key findings: messages matching actionable patterns
  const findingPatterns = /\b(?:finding|issue|recommend|suggest|fix|bug|improvement)\b/i
  const keyFindings = agentMsgs
    .filter(m => findingPatterns.test(m.content))
    .slice(-5)
    .map(m => {
      const cleaned = stripPaths(m.content)
      return `  [${m.from}]: ${cleaned.slice(0, 500)}`
    })
  const keyFindingsSection = keyFindings.length > 0
    ? `\n\nKey findings:\n${keyFindings.join('\n')}`
    : ''

  const summaryFile = collabSummaryFile(teamId)
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
  fs.writeFileSync(
    summaryFile,
    `Task: ${team.description || 'unknown'}\nDuration: ${duration}\nMessages: ${agentMsgs.length}\n\n${summaryText}${keyFindingsSection}`,
  )
  console.log(`[Ensemble] Summary written to ${summaryFile}`)
}

export async function disbandTeam(teamId: string, reason?: 'completed' | 'manual' | 'error' | 'auto'): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

  // Record disband reason
  const disbandReason = reason || 'manual'
  appendMessage(teamId, {
    id: uuidv4(), teamId, from: 'ensemble', to: 'team',
    content: `Team disbanded (reason: ${disbandReason})`,
    type: 'chat', timestamp: new Date().toISOString(),
  })

  // Write summary before killing sessions so the Claude Code session can present it
  await writeDisbandSummary(teamId)

  // Scrape token usage BEFORE killing sessions (tmux panes disappear on kill)
  const tokenUsageMap: Record<string, string> = {}
  await Promise.all(
    team.agents
      .filter(a => a.status === 'active')
      .map(async (agent) => {
        const sessionName = `${team.name}-${agent.name}`
        tokenUsageMap[agent.name] = await getAgentTokenUsage(sessionName)
      })
  )

  for (const agent of team.agents) {
    if (agent.status === 'active') {
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: `${agent.name} has left #${team.name}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })

      try {
        if (agent.hostId && !isSelf(agent.hostId)) {
          const host = getHostById(agent.hostId)
          if (host && agent.agentId) await killRemoteAgent(host.url, agent.agentId)
        } else {
          await killLocalAgent(`${team.name}-${agent.name}`)
        }
      } catch { /* session may already be gone */ }
    }
  }

  const agentsWithWorktrees = team.agents.filter(
    a => a.worktreePath && a.worktreeBranch && (!a.hostId || isSelf(a.hostId))
  )
  if (agentsWithWorktrees.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 2000))

    const firstWorktree = agentsWithWorktrees[0].worktreePath!
    const worktreesDir = path.dirname(firstWorktree)
    const basePath = path.dirname(worktreesDir)

    for (const agent of agentsWithWorktrees) {
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      const result = await mergeWorktree(worktreeInfo, basePath)

      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: result.success
          ? `🌳 Merged ${agent.name}'s worktree (${agent.worktreeBranch})`
          : `⚠️ Merge conflict for ${agent.name}: ${result.conflicts?.join(', ')}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

    for (const agent of agentsWithWorktrees) {
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      await destroyWorktree(worktreeInfo, basePath)
    }
  }

  // Store disband reason in result
  const existingResult = team.result || { summary: '', decisions: [], discoveries: [], filesChanged: [], duration: 0 }
  const durationMs = Date.now() - new Date(team.createdAt).getTime()

  const updated = updateTeam(teamId, {
    status: 'disbanded',
    completedAt: new Date().toISOString(),
    result: { ...existingResult, duration: durationMs, disbandReason },
  })

  // Soft cleanup: remove ephemeral files, keep messages/summary/log, write .finished marker
  try {
    const deliveryDir = path.join(collabRuntimeDir(teamId), 'delivery')
    if (fs.existsSync(deliveryDir)) fs.rmSync(deliveryDir, { recursive: true, force: true })
    for (const f of [collabBridgeResult(teamId), collabBridgePosted(teamId)]) {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
    fs.writeFileSync(collabFinishedMarker(teamId), new Date().toISOString())
  } catch { /* non-fatal cleanup */ }

  // Optional: save session summary to claude-mem
  try {
    const messages = getMessages(teamId)
    const agentMessages = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')
    if (agentMessages.length > 0) {
      const durationMs = updated!.completedAt && team.createdAt
        ? new Date(updated!.completedAt).getTime() - new Date(team.createdAt).getTime()
        : 0
      const duration = formatDuration(durationMs)

      // Build a concise summary with token usage
      const agents = [...new Set(agentMessages.map(m => m.from))]
      const summaryParts = agents.map(agent => {
        const msgs = agentMessages.filter(m => m.from === agent)
        const first = msgs[0]?.content.slice(0, 300) || ''
        const last = msgs[msgs.length - 1]?.content.slice(0, 500) || ''
        const tokens = tokenUsageMap[agent] || 'unknown'
        return `${agent} (${msgs.length} msgs, tokens: ${tokens}):\n  Start: ${first}\n  End: ${last}`
      })

      sendTelegramSummary({
        task: team.description || 'unknown',
        duration,
        messageCount: agentMessages.length,
        agentSummaries: agents.map(agent => ({
          name: agent,
          msgs: agentMessages.filter(m => m.from === agent).length,
          tokens: tokenUsageMap[agent] || '?',
        })),
      })

      // Detect the working directory as project hint
      const cwdMatch = team.description.match(/workingDirectory[:\s]*([^\s,}]+)/)
      const project = process.env.ENSEMBLE_PROJECT
        || (cwdMatch ? cwdMatch[1].split('/').pop() : undefined)
        || 'ensemble'

      fetch('http://localhost:37777/api/observations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Collab: ${team.description.slice(0, 80)}`,
          subtitle: `${agents.join(' + ')} — ${duration}, ${agentMessages.length} messages`,
          type: 'discovery',
          narrative: `Team "${team.name}" (${duration}):\nTask: ${team.description.slice(0, 200)}\n\n${summaryParts.join('\n\n')}`,
          project,
        }),
      }).catch(() => {})
    }
  } catch { /* non-fatal */ }

  // Auto-generate AI summary in the background (non-blocking)
  if (process.env.ENSEMBLE_AUTO_SUMMARY !== 'false') {
    void generateAutoSummary(teamId).catch(err => {
      console.error(`[Ensemble] Auto-summary failed for ${teamId}:`, err)
    })
  }

  return { data: { team: updated! }, status: 200 }
}

/**
 * Auto-generate AI summary using claude --print (runs in background after disband).
 * Skipped if ENSEMBLE_AUTO_SUMMARY=false.
 */
async function generateAutoSummary(teamId: string): Promise<void> {
  const team = getTeam(teamId)
  if (!team) return

  const allMessages = getMessages(teamId)
  const agentMessages = allMessages.filter(m => m.from !== 'ensemble')
  if (agentMessages.length < 3) return // not enough content to summarize

  const durationMs = team.completedAt
    ? new Date(team.completedAt).getTime() - new Date(team.createdAt).getTime()
    : 0
  const duration = formatDuration(durationMs)
  const agentNames = team.agents.map(a => a.name).join(', ')

  const formattedMessages = agentMessages
    .slice(-50)
    .map(m => `${m.from}: ${m.content.slice(0, 500)}`)
    .join('\n')

  const summaryPrompt = [
    `Summarize this AI agent collaboration concisely.`,
    `Team: ${team.name} | Task: ${team.description} | Duration: ${duration} | Agents: ${agentNames}`,
    `Return JSON: {"summary":"2-3 sentences","decisions":["..."],"accomplished":["..."],"issues":["..."],"filesChanged":["..."]}`,
    `Messages:\n${formattedMessages}`,
  ].join('\n')

  const promptFile = path.join(os.tmpdir(), `ensemble-autosummary-${teamId.slice(0, 8)}.txt`)
  fs.writeFileSync(promptFile, summaryPrompt)

  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const isWindows = os.platform() === 'win32'

    const { stdout } = await execFileAsync('claude', [
      '--print', '--output-format', 'text', '-p',
      `Read ${promptFile} and return the JSON summary. Return ONLY valid JSON.`,
    ], { timeout: 120000, maxBuffer: 1024 * 1024, shell: isWindows })

    if (stdout?.trim()) {
      const jsonMatch = stdout.match(/\{[\s\S]*"summary"[\s\S]*\}/)
      if (jsonMatch) {
        try {
          const obj = JSON.parse(jsonMatch[0])
          const existingResult = team.result || { summary: '', decisions: [], discoveries: [], filesChanged: [], duration: 0 }
          updateTeam(teamId, {
            result: {
              ...existingResult,
              aiSummary: obj.summary || stdout.trim(),
              decisions: obj.decisions || existingResult.decisions,
              discoveries: obj.accomplished || existingResult.discoveries,
              filesChanged: obj.filesChanged || existingResult.filesChanged,
            },
          })
          console.log(`[Ensemble] Auto-summary generated for ${teamId}`)
        } catch { /* JSON parse failed, store raw */
          const existingResult = team.result || { summary: '', decisions: [], discoveries: [], filesChanged: [], duration: 0 }
          updateTeam(teamId, { result: { ...existingResult, aiSummary: stdout.trim() } })
        }
      }
    }
  } catch (err) {
    console.error(`[Ensemble] Auto-summary generation failed:`, err)
  } finally {
    try { fs.unlinkSync(promptFile) } catch { /* ok */ }
  }
}

/**
 * Permanently delete a team and all its data — registry entry, messages, runtime files.
 * Only works on disbanded/completed/failed teams. Active teams must be disbanded first.
 */
export function deleteTeamPermanently(teamId: string): ServiceResult<{ deleted: boolean }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

  if (team.status === 'active' || team.status === 'forming') {
    return { error: 'Cannot delete an active team. Disband it first.', status: 400 }
  }

  // Remove runtime directory (messages.jsonl, summary.txt, prompts, etc.)
  try {
    const runtimeDir = collabRuntimeDir(teamId)
    if (fs.existsSync(runtimeDir)) fs.rmSync(runtimeDir, { recursive: true, force: true })
  } catch { /* non-fatal */ }

  // Remove from registry (teams.json + feed messages)
  deleteTeamFromRegistry(teamId)

  return { data: { deleted: true }, status: 200 }
}

/**
 * Clone a previous team as a new team — same task + agents, optionally seeded
 * with message context from the original.
 */
export async function cloneTeam(
  sourceTeamId: string,
  options: { seedMessages?: boolean; workingDirectory?: string } = {},
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const source = getTeam(sourceTeamId)
  if (!source) return { error: 'Source team not found', status: 404 }

  // Build the create request from the source team
  const request: CreateTeamRequest = {
    name: `${source.name.replace(/-\d+$/, '')}-${Date.now()}`,
    description: source.description,
    agents: source.agents.map((a, i) => ({
      program: a.program,
      role: a.role || (i === 0 ? 'lead' : 'worker'),
      hostId: a.hostId || undefined,
    })),
    feedMode: source.feedMode || 'live',
    workingDirectory: options.workingDirectory || undefined,
  }

  // Create the new team (non-blocking — spawns in background)
  const result = await createEnsembleTeam(request)
  if (result.error || !result.data) return result

  const newTeam = result.data.team

  // Optionally seed with context from the source team's messages
  if (options.seedMessages) {
    const sourceMessages = getMessages(sourceTeamId)
    const agentMessages = sourceMessages
      .filter(m => m.from !== 'ensemble')
      .slice(-15) // last 15 messages as context

    if (agentMessages.length > 0) {
      const contextSummary = agentMessages
        .map(m => `${m.from}: ${m.content.slice(0, 300)}`)
        .join('\n')

      appendMessage(newTeam.id, {
        id: uuidv4(),
        teamId: newTeam.id,
        from: 'ensemble',
        to: 'team',
        content: `Continuing from previous session (${source.name}):\n\n${contextSummary}`,
        type: 'chat',
        timestamp: new Date().toISOString(),
      })
    }
  }

  return result
}

/* ── Export types ────────────────────────────────────────────────── */

interface ExportPromptResult {
  prompt: string
  actionItems: string[]
  sourceTeam: string
}

interface ExportJsonResult {
  task: string
  plan: { steps: string[] }
  summary: string
  findings: string[]
  actionItems: string[]
  messages: Array<{ from: string; content: string }>
}

/**
 * Export a team's output (plan, summary, findings) in a specified format.
 * Designed to feed collab output into the next action.
 */
export function exportTeam(
  teamId: string,
  format: 'prompt' | 'json' | 'markdown',
): ServiceResult<{ prompt?: string; actionItems?: string[]; sourceTeam?: string; export?: ExportJsonResult; markdown?: string }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

  const allMessages = getMessages(teamId)
  const agentMessages = allMessages
    .filter(m => m.from !== 'ensemble')
    .slice(-50)

  // Extract plan steps if available
  const planSteps: string[] = team.plan?.steps
    ? team.plan.steps.map(s => s.text)
    : []

  // Extract action items from messages — lines that look like action items
  const actionItemPatterns = [
    /^[-*]\s+(?:TODO|FIXME|ACTION|FIX|ADD|UPDATE|REMOVE|CREATE|IMPLEMENT|WRITE|REFACTOR):\s*/i,
    /^[-*]\s+/,
    /^\d+\.\s+/,
  ]

  const actionItems: string[] = []
  for (const msg of agentMessages) {
    const lines = msg.content.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length < 10 || trimmed.length > 200) continue
      if (actionItemPatterns.some(p => p.test(trimmed))) {
        // Clean the prefix
        const cleaned = trimmed
          .replace(/^[-*]\s+(?:TODO|FIXME|ACTION|FIX|ADD|UPDATE|REMOVE|CREATE|IMPLEMENT|WRITE|REFACTOR):\s*/i, '')
          .replace(/^[-*]\s+/, '')
          .replace(/^\d+\.\s+/, '')
        if (cleaned.length >= 8) actionItems.push(cleaned)
      }
    }
  }

  // Use plan steps as action items if no explicit ones found
  const finalActionItems = actionItems.length > 0 ? actionItems : planSteps

  // Summary text
  const summaryText = team.result?.aiSummary || team.result?.summary || ''

  // Findings from discoveries + decisions
  const findings: string[] = [
    ...(team.result?.discoveries || []),
    ...(team.result?.decisions || []),
  ]

  // Key agent messages (filtered for substance, not noise)
  const keyMessages = agentMessages
    .filter(m => m.content.length > 50)
    .slice(-20)
    .map(m => ({ from: m.from, content: m.content.slice(0, 500) }))

  if (format === 'prompt') {
    const parts: string[] = []

    parts.push(`Execute the following plan from team ${team.name}:`)
    parts.push('')

    if (team.description) {
      parts.push(`Task: ${team.description}`)
      parts.push('')
    }

    if (planSteps.length > 0) {
      parts.push('Plan:')
      planSteps.forEach((step, i) => {
        parts.push(`${i + 1}. ${step}`)
      })
      parts.push('')
    }

    if (finalActionItems.length > 0 && finalActionItems !== planSteps) {
      parts.push('Action Items:')
      finalActionItems.forEach((item, i) => {
        parts.push(`${i + 1}. ${item}`)
      })
      parts.push('')
    }

    if (summaryText) {
      parts.push(`Context: ${summaryText}`)
      parts.push('')
    }

    if (findings.length > 0) {
      parts.push('Findings:')
      findings.forEach(f => parts.push(`- ${f}`))
      parts.push('')
    }

    const prompt = parts.join('\n').trim()

    return {
      data: {
        prompt,
        actionItems: finalActionItems,
        sourceTeam: team.id,
      },
      status: 200,
    }
  }

  if (format === 'json') {
    const exportData: ExportJsonResult = {
      task: team.description,
      plan: { steps: planSteps },
      summary: summaryText,
      findings,
      actionItems: finalActionItems,
      messages: keyMessages,
    }
    return { data: { export: exportData }, status: 200 }
  }

  if (format === 'markdown') {
    const lines: string[] = []

    lines.push(`# Team Report: ${team.name}`)
    lines.push('')
    lines.push(`**Status:** ${team.status}`)
    lines.push(`**Created:** ${team.createdAt}`)
    if (team.completedAt) lines.push(`**Completed:** ${team.completedAt}`)
    lines.push(`**Agents:** ${team.agents.map(a => a.name).join(', ')}`)
    lines.push('')

    lines.push('## Task')
    lines.push('')
    lines.push(team.description)
    lines.push('')

    if (summaryText) {
      lines.push('## Summary')
      lines.push('')
      lines.push(summaryText)
      lines.push('')
    }

    if (planSteps.length > 0) {
      lines.push('## Plan')
      lines.push('')
      planSteps.forEach((step, i) => {
        lines.push(`${i + 1}. ${step}`)
      })
      lines.push('')
    }

    if (finalActionItems.length > 0) {
      lines.push('## Action Items')
      lines.push('')
      finalActionItems.forEach(item => {
        lines.push(`- ${item}`)
      })
      lines.push('')
    }

    if (findings.length > 0) {
      lines.push('## Findings')
      lines.push('')
      findings.forEach(f => {
        lines.push(`- ${f}`)
      })
      lines.push('')
    }

    if (team.result?.filesChanged && team.result.filesChanged.length > 0) {
      lines.push('## Files Changed')
      lines.push('')
      team.result.filesChanged.forEach(f => {
        lines.push(`- \`${f}\``)
      })
      lines.push('')
    }

    if (keyMessages.length > 0) {
      lines.push('## Key Messages')
      lines.push('')
      keyMessages.forEach(m => {
        lines.push(`**${m.from}:** ${m.content}`)
        lines.push('')
      })
    }

    return { data: { markdown: lines.join('\n') }, status: 200 }
  }

  return { error: 'Invalid format. Use "prompt", "json", or "markdown".', status: 400 }
}

/**
 * Execute a team's plan/findings by creating a new team with the exported
 * prompt as the task description.
 *
 * Similar to cloneTeam, but the description becomes the exported prompt
 * instead of the original task.
 */
export async function executeTeam(
  sourceTeamId: string,
  options: { agents: Array<{ program: string; role?: string }>; workingDirectory?: string } = { agents: [] },
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  // Build the prompt from the source team's output
  const exportResult = exportTeam(sourceTeamId, 'prompt')
  if (exportResult.error || !exportResult.data?.prompt) {
    return { error: exportResult.error || 'Failed to export team', status: exportResult.status }
  }

  const source = getTeam(sourceTeamId)
  if (!source) return { error: 'Source team not found', status: 404 }

  // Determine agents: use provided list or fall back to source team agents
  const agents = options.agents.length > 0
    ? options.agents.map((a, i) => ({
        program: a.program,
        role: a.role || (i === 0 ? 'lead' : 'worker'),
      }))
    : source.agents.map((a, i) => ({
        program: a.program,
        role: a.role || (i === 0 ? 'lead' : 'worker'),
      }))

  const request: CreateTeamRequest = {
    name: `exec-${source.name.replace(/-\d+$/, '')}-${Date.now()}`,
    description: exportResult.data.prompt,
    agents,
    feedMode: source.feedMode || 'live',
    workingDirectory: options.workingDirectory || undefined,
  }

  const result = await createEnsembleTeam(request)
  if (result.error || !result.data) return result

  // Seed the new team with a reference to the source
  appendMessage(result.data.team.id, {
    id: uuidv4(),
    teamId: result.data.team.id,
    from: 'ensemble',
    to: 'team',
    content: `Executing plan from team "${source.name}" (${source.id}).`,
    type: 'chat',
    timestamp: new Date().toISOString(),
  })

  return result
}
