/**
 * Ensemble Server — Standalone HTTP server
 * Lightweight replacement for Next.js API routes.
 */

import fs from 'fs'
import os from 'os'
import nodePath from 'path'
import { fileURLToPath } from 'url'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import {
  createEnsembleTeam, getEnsembleTeam, listEnsembleTeams,
  getTeamFeed, sendTeamMessage, disbandTeam, deleteTeamPermanently, reopenTeam,
  addAgentToTeam, cloneTeam, exportTeam, executeTeam, listCollabTemplates,
  joinTeam, sendRemoteMessage, leaveTeam, kickParticipant,
  updateTeamVisibility, generateShareLink, getLobbyTeams,
  validateSessionToken, setSpectatorCountFn,
} from './services/ensemble-service'
import { getTeam, updateTeam } from './lib/ensemble-registry'
import type { TeamConfig } from './types/ensemble'
import { getRuntime } from './lib/agent-runtime'
import { color, styledHeader, styledLog, styledStatus } from './lib/cli-style'

const __filename = fileURLToPath(import.meta.url)
const __dirname = nodePath.dirname(__filename)

const PORT = parseInt(process.env.ENSEMBLE_PORT || process.env.ORCHESTRA_PORT || '23000', 10)
const HOST = process.env.ENSEMBLE_HOST || '127.0.0.1'
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 600
const DEFAULT_CORS_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(?::\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/i,
  /^http:\/\/\[::1\](?::\d+)?$/i,
]

type RateLimitEntry = {
  count: number
  windowStart: number
}

const rateLimitByIp = new Map<string, RateLimitEntry>()

// Per-team join rate limit: max 10 joins per minute
const joinRateLimitByTeam = new Map<string, { count: number; windowStart: number }>()

function isJoinRateLimited(teamId: string): boolean {
  const now = Date.now()
  const current = joinRateLimitByTeam.get(teamId)
  if (!current || now - current.windowStart >= 60_000) {
    joinRateLimitByTeam.set(teamId, { count: 1, windowStart: now })
    return false
  }
  current.count++
  return current.count > 10
}

function stripSensitiveFields(team: any) {
  if (team.participants) {
    team.participants = team.participants.map((p: any) => {
      const { tokenHash, ...safe } = p
      return safe
    })
  }
  if (team.joinToken) delete team.joinToken
  return team
}

// Track active SSE connections for cleanup
type SseConnection = {
  res: http.ServerResponse
  interval: ReturnType<typeof setInterval>
  teamId: string
}
const activeSseConnections = new Set<SseConnection>()

// Track typing state per team: participantId → { isTyping, lastSeen }
const typingState = new Map<string, Map<string, { isTyping: boolean; lastSeen: number }>>()

function broadcastToTeamStreams(teamId: string, eventName: string, data: unknown) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
  for (const conn of activeSseConnections) {
    if (conn.teamId === teamId) {
      try { conn.res.write(payload) } catch { /* ignore */ }
    }
  }
  for (const conn of activeSpectatorConnections) {
    if (conn.teamId === teamId) {
      try { conn.res.write(payload) } catch { /* ignore */ }
    }
  }
}

// Track active session SSE connections for cleanup
type SessionSseConnection = {
  res: http.ServerResponse
  interval: ReturnType<typeof setInterval>
  sessionName: string
}
const activeSessionSseConnections = new Set<SessionSseConnection>()

// Track spectator SSE connections
type SpectatorSseConnection = {
  res: http.ServerResponse
  interval: ReturnType<typeof setInterval>
  teamId: string
}
const activeSpectatorConnections = new Set<SpectatorSseConnection>()

// Register spectator count function with the service
setSpectatorCountFn((teamId: string) =>
  [...activeSpectatorConnections].filter(c => c.teamId === teamId).length
)

/** Validate session name: alphanumeric, hyphens, underscores, dots only */
function isValidSessionName(name: string): boolean {
  return /^[a-zA-Z0-9\-_.]+$/.test(name)
}

// Periodic cleanup of stale rate limit entries to prevent unbounded Map growth
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitByIp) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitByIp.delete(ip)
    }
  }
}, 60_000)

function getAllowedCorsOrigins(): string[] {
  const configured = process.env.ENSEMBLE_CORS_ORIGIN?.trim()
  if (!configured) return []

  return configured
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
}

function isAllowedOrigin(origin: string): boolean {
  const configuredOrigins = getAllowedCorsOrigins()
  if (configuredOrigins.length > 0) return configuredOrigins.includes(origin)
  return DEFAULT_CORS_ORIGIN_PATTERNS.some(pattern => pattern.test(origin))
}

function buildCorsHeaders(origin?: string, isPublicEndpoint?: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  }

  if (isPublicEndpoint && process.env.ENSEMBLE_PUBLIC_CORS === 'true') {
    headers['Access-Control-Allow-Origin'] = '*'
  } else if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }

  return headers
}

function json(res: http.ServerResponse, data: unknown, status = 200, origin?: string) {
  res.writeHead(status, buildCorsHeaders(origin))
  res.end(JSON.stringify(data))
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function getClientIp(req: http.IncomingMessage): string {
  const forwardedFor = req.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string') {
    const firstIp = forwardedFor.split(',')[0]?.trim()
    if (firstIp) return firstIp
  }

  return req.socket.remoteAddress || 'unknown'
}

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const current = rateLimitByIp.get(ip)

  if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitByIp.set(ip, { count: 1, windowStart: now })
    return false
  }

  current.count += 1
  return current.count > RATE_LIMIT_MAX_REQUESTS
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  const path = url.pathname
  const method = req.method || 'GET'
  const origin = req.headers.origin

  if (origin && !isAllowedOrigin(origin)) {
    return json(res, { error: 'CORS origin forbidden' }, 403, origin)
  }

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, buildCorsHeaders(origin))
    res.end()
    return
  }

  if (isRateLimited(getClientIp(req))) {
    return json(res, { error: 'Rate limit exceeded' }, 429, origin)
  }

  try {
    // Health check
    if (path === '/api/v1/health') {
      return json(res, { status: 'healthy', version: '1.0.0' }, 200, origin)
    }

    // Server info — cwd, available agents, recent project dirs
    if (path === '/api/ensemble/info' && method === 'GET') {
      const { loadAgentsConfig } = await import('./lib/agent-config')
      const agentsConfig = loadAgentsConfig()
      const agents = Object.entries(agentsConfig).map(([key, agent]) => ({
        id: key,
        name: (agent as { name: string }).name,
        color: (agent as { color: string }).color,
        icon: (agent as { icon: string }).icon,
      }))
      const templates = listCollabTemplates()

      // Collect unique working directories from recent team descriptions
      // (workingDirectory isn't stored on the team object, but descriptions often reference paths)
      const recentDirs: string[] = []

      const mcpServerPath = nodePath.resolve(__dirname, 'mcp', 'ensemble-mcp-server.mjs')

      // Scan ENSEMBLE_PROJECTS_DIR for project subdirectories
      const projectDirectories: Array<{ name: string; path: string }> = []
      const projectsDir = process.env.ENSEMBLE_PROJECTS_DIR
      if (projectsDir) {
        try {
          const entries = fs.readdirSync(projectsDir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory()) {
              projectDirectories.push({
                name: entry.name,
                path: nodePath.resolve(projectsDir, entry.name),
              })
            }
          }
          projectDirectories.sort((a, b) => a.name.localeCompare(b.name))
        } catch {
          // ENSEMBLE_PROJECTS_DIR not readable — return empty array
        }
      }

      return json(res, {
        cwd: process.cwd(),
        agents,
        templates,
        mcpServerPath,
        launchDefaults: {
          minAgents: 2,
          maxAgents: 4,
          feedMode: 'live',
        },
        recentDirectories: recentDirs,
        projectDirectories,
      }, 200, origin)
    }

    // -----------------------------------------------------------------------
    // Server configuration endpoints
    // -----------------------------------------------------------------------

    // GET /api/ensemble/config — return current server configuration
    if (path === '/api/ensemble/config' && method === 'GET') {
      const { loadAgentsConfig: loadAgents } = await import('./lib/agent-config')
      const { getEnsembleDataDir } = await import('./lib/ensemble-paths')
      const { getCollabRuntimeRoot } = await import('./lib/collab-paths')
      const { DEFAULT_NUDGE_MS, DEFAULT_STALL_MS, DEFAULT_POLL_INTERVAL_MS } = await import('./lib/agent-watchdog')
      const agentsConfig = loadAgents()
      const startTime = (server as unknown as { _ensembleStartTime?: number })._ensembleStartTime ?? Date.now()

      return json(res, {
        port: PORT,
        host: HOST,
        commMode: process.env.ENSEMBLE_COMM_MODE || 'mcp',
        autoSummary: process.env.ENSEMBLE_AUTO_SUMMARY !== 'false',
        watchdog: {
          nudgeMs: parseInt(process.env.ENSEMBLE_WATCHDOG_NUDGE_MS || '', 10) || DEFAULT_NUDGE_MS,
          stallMs: parseInt(process.env.ENSEMBLE_WATCHDOG_STALL_MS || '', 10) || DEFAULT_STALL_MS,
          pollMs: DEFAULT_POLL_INTERVAL_MS,
        },
        completion: {
          windowMs: 60_000,
          singleSignalIdleMs: 120_000,
        },
        agents: agentsConfig,
        dataDir: getEnsembleDataDir(),
        runtimeDir: getCollabRuntimeRoot(),
        about: {
          version: '1.0.0',
          nodeVersion: process.version,
          platform: os.platform(),
          uptime: Math.floor((Date.now() - startTime) / 1000),
        },
      }, 200, origin)
    }

    // PATCH /api/ensemble/config — update runtime-modifiable settings
    if (path === '/api/ensemble/config' && method === 'PATCH') {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
      }

      const updated: Record<string, unknown> = {}

      // commMode: mcp | shell
      if ('commMode' in body) {
        const val = body.commMode
        if (val === 'mcp' || val === 'shell') {
          process.env.ENSEMBLE_COMM_MODE = val
          updated.commMode = val
        } else {
          return json(res, { error: 'Bad Request: commMode must be "mcp" or "shell"' }, 400, origin)
        }
      }

      // autoSummary: boolean
      if ('autoSummary' in body) {
        const val = body.autoSummary
        if (typeof val === 'boolean') {
          process.env.ENSEMBLE_AUTO_SUMMARY = val ? 'true' : 'false'
          updated.autoSummary = val
        } else {
          return json(res, { error: 'Bad Request: autoSummary must be a boolean' }, 400, origin)
        }
      }

      // watchdog nudgeMs
      if ('watchdogNudgeMs' in body) {
        const val = Number(body.watchdogNudgeMs)
        if (Number.isFinite(val) && val > 0) {
          process.env.ENSEMBLE_WATCHDOG_NUDGE_MS = String(val)
          updated.watchdogNudgeMs = val
        } else {
          return json(res, { error: 'Bad Request: watchdogNudgeMs must be a positive number' }, 400, origin)
        }
      }

      // watchdog stallMs
      if ('watchdogStallMs' in body) {
        const val = Number(body.watchdogStallMs)
        if (Number.isFinite(val) && val > 0) {
          process.env.ENSEMBLE_WATCHDOG_STALL_MS = String(val)
          updated.watchdogStallMs = val
        } else {
          return json(res, { error: 'Bad Request: watchdogStallMs must be a positive number' }, 400, origin)
        }
      }

      if (Object.keys(updated).length === 0) {
        return json(res, { error: 'No valid fields to update' }, 400, origin)
      }

      return json(res, { updated }, 200, origin)
    }

    // List teams / Create team
    if (path === '/api/ensemble/teams') {
      if (method === 'GET') {
        const result = listEnsembleTeams()
        return json(res, result.data, result.status, origin)
      }
      if (method === 'POST') {
        let body: unknown
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
        const result = await createEnsembleTeam(body as Parameters<typeof createEnsembleTeam>[0])
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
    }

    // ── Lobby: GET /api/ensemble/lobby ──────────────────────────────
    if (path === '/api/ensemble/lobby' && method === 'GET') {
      const tag = url.searchParams.get('tag') || undefined
      const status = url.searchParams.get('status') || undefined
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)
      const result = getLobbyTeams({ tag, status, limit, offset })
      const safeData = result.data ? {
        ...result.data,
        teams: result.data.teams.map((t: any) => stripSensitiveFields({ ...t })),
      } : result.data
      return json(res, safeData, result.status, origin)
    }

    // ── Open Participation sub-routes (must match before teamMatch) ──

    // POST /api/ensemble/teams/:id/join
    const joinMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/join$/)
    if (joinMatch && method === 'POST') {
      const teamId = joinMatch[1]
      if (isJoinRateLimited(teamId)) {
        return json(res, { error: 'Too many join requests. Try again later.' }, 429, origin)
      }
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) } catch { /* empty ok */ }
      const clientIp = getClientIp(req)
      const result = joinTeam(teamId, body as unknown as Parameters<typeof joinTeam>[1], clientIp)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // POST /api/ensemble/teams/:id/messages (remote participant send)
    const remoteMessageMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/messages$/)
    if (remoteMessageMatch && method === 'POST') {
      const teamId = remoteMessageMatch[1]
      const authHeader = req.headers.authorization
      if (!authHeader?.startsWith('Bearer ')) {
        return json(res, { error: 'Missing Authorization header' }, 401, origin)
      }
      const token = authHeader.slice(7)
      const payload = validateSessionToken(token)
      if (!payload || payload.tid !== teamId) {
        return json(res, { error: 'Invalid or expired session token' }, 401, origin)
      }
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) } catch { /* empty ok */ }
      const content = typeof body.content === 'string' ? body.content : ''
      if (!content.trim()) {
        return json(res, { error: 'content is required' }, 400, origin)
      }
      const result = await sendRemoteMessage(teamId, payload.pid, content, typeof body.to === 'string' ? body.to : undefined)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // POST /api/ensemble/teams/:id/leave
    const leaveMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/leave$/)
    if (leaveMatch && method === 'POST') {
      const teamId = leaveMatch[1]
      const authHeader = req.headers.authorization
      if (!authHeader?.startsWith('Bearer ')) {
        return json(res, { error: 'Missing Authorization header' }, 401, origin)
      }
      const token = authHeader.slice(7)
      const payload = validateSessionToken(token)
      if (!payload || payload.tid !== teamId) {
        return json(res, { error: 'Invalid or expired session token' }, 401, origin)
      }
      const result = leaveTeam(teamId, payload.pid)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // DELETE /api/ensemble/teams/:id/participants/:pid (kick)
    const kickMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/participants\/([^/]+)$/)
    if (kickMatch && method === 'DELETE') {
      const [, teamId, participantId] = kickMatch
      const result = kickParticipant(teamId, participantId)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // POST /api/ensemble/teams/:id/share
    const shareMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/share$/)
    if (shareMatch && method === 'POST') {
      const teamId = shareMatch[1]
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) } catch { /* empty ok */ }
      const expiresIn = typeof body.expiresIn === 'string' ? body.expiresIn : undefined
      const result = generateShareLink(teamId, expiresIn)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // GET /api/ensemble/teams/:id/spectate (SSE, no auth for public; token for shared)
    const spectateMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/spectate$/)
    if (spectateMatch && method === 'GET') {
      const teamId = spectateMatch[1]
      const team = getTeam(teamId)
      if (!team) return json(res, { error: 'Team not found' }, 404, origin)

      // Auth gate
      if (team.visibility === 'private') {
        return json(res, { error: 'This team is private' }, 403, origin)
      }
      if (team.visibility === 'shared') {
        const token = url.searchParams.get('token')
        if (!token || token !== team.joinToken) {
          return json(res, { error: 'Invalid or missing token' }, 403, origin)
        }
      }
      // public → no auth needed

      const sseHeaders = buildCorsHeaders(origin, team.visibility === 'public')
      sseHeaders['Content-Type'] = 'text/event-stream'
      sseHeaders['Cache-Control'] = 'no-cache'
      sseHeaders['Connection'] = 'keep-alive'
      res.writeHead(200, sseHeaders)

      // Send init
      const teamResult = getEnsembleTeam(teamId)
      const initData = teamResult.data
      const safeInitParticipants = (initData?.team.participants ?? []).map((p: any) => {
        const { tokenHash, ...safe } = p
        return safe
      })
      const safeInitTeam = initData?.team ? stripSensitiveFields({ ...initData.team }) : initData?.team
      res.write(`event: init\ndata: ${JSON.stringify({
        team: safeInitTeam,
        messages: initData?.messages ?? [],
        participants: safeInitParticipants,
      })}\n\n`)

      let lastTimestamp: string | undefined
      const msgs = initData?.messages ?? []
      if (msgs.length > 0) lastTimestamp = msgs[msgs.length - 1].timestamp

      let spectateStatsTick = 0
      const interval = setInterval(() => {
        const feedResult = getTeamFeed(teamId, lastTimestamp)
        if (feedResult.error) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: feedResult.error })}\n\n`)
          res.end()
          return
        }
        const newMsgs = feedResult.data!.messages
        if (newMsgs.length > 0) {
          lastTimestamp = newMsgs[newMsgs.length - 1].timestamp
          res.write(`event: message\ndata: ${JSON.stringify({ messages: newMsgs })}\n\n`)
        }

        // Emit stats every 10s
        spectateStatsTick++
        if (spectateStatsTick % 5 === 0) {
          const currentTeam = getTeam(teamId)
          if (currentTeam) {
            const spectatorCount = [...activeSpectatorConnections].filter(c => c.teamId === teamId).length
            const allMsgs = getEnsembleTeam(teamId).data?.messages ?? []
            const elapsedMs = Date.now() - new Date(currentTeam.createdAt).getTime()
            res.write(`event: stats\ndata: ${JSON.stringify({
              spectator_count: spectatorCount,
              message_count: allMsgs.length,
              elapsed_ms: elapsedMs,
            })}\n\n`)
          }
        }

        const currentTeam = getTeam(teamId)
        if (currentTeam?.status === 'disbanded') {
          res.write(`event: disbanded\ndata: ${JSON.stringify({ team: currentTeam })}\n\n`)
          res.end()
        }
      }, 2000)
      interval.unref()

      const conn: SpectatorSseConnection = { res, interval, teamId }
      activeSpectatorConnections.add(conn)
      req.on('close', () => {
        clearInterval(interval)
        activeSpectatorConnections.delete(conn)
      })
      return
    }

    // POST /api/ensemble/teams/:id/typing — broadcast typing indicator
    const typingMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/typing$/)
    if (typingMatch && method === 'POST') {
      const teamId = typingMatch[1]
      const team = getTeam(teamId)
      if (!team) return json(res, { error: 'Team not found' }, 404, origin)
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) } catch { /* ok */ }
      const participantId = typeof body.participant_id === 'string' ? body.participant_id : 'unknown'
      const isTyping = body.is_typing !== false

      // Update typing state
      if (!typingState.has(teamId)) typingState.set(teamId, new Map())
      const teamTyping = typingState.get(teamId)!
      teamTyping.set(participantId, { isTyping, lastSeen: Date.now() })

      // Broadcast to all SSE streams for this team
      broadcastToTeamStreams(teamId, isTyping ? 'typing' : 'typing_stop', { participant_id: participantId, is_typing: isTyping })

      return json(res, { ok: true }, 200, origin)
    }

    // GET /api/ensemble/teams/:id/replay — full history for disbanded teams
    const replayMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/replay$/)
    if (replayMatch && method === 'GET') {
      const teamId = replayMatch[1]
      const teamResult = getEnsembleTeam(teamId)
      if (teamResult.error) return json(res, { error: teamResult.error }, teamResult.status, origin)
      const teamData = teamResult.data!
      return json(res, {
        team: stripSensitiveFields({ ...teamData.team }),
        messages: teamData.messages,
        replayUrl: `/replay/${teamId}`,
      }, 200, origin)
    }

    // Team operations: /api/ensemble/teams/:id
    const teamMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)$/)
    if (teamMatch) {
      const teamId = teamMatch[1]
      if (method === 'GET') {
        const result = getEnsembleTeam(teamId)
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        const safeData = result.data ? { ...result.data, team: stripSensitiveFields({ ...result.data.team }) } : result.data
        return json(res, safeData, result.status, origin)
      }
      if (method === 'POST') {
        let body: Record<string, unknown>
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
        const result = await sendTeamMessage(teamId, (body.to as string) || 'team', body.content as string, body.from as string, body.id as string, body.timestamp as string, body.type as string)
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
      if (method === 'PATCH') {
        let body: Record<string, unknown>
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
        const visibility = body.visibility as string | undefined
        const lifecycle = body.lifecycle as string | undefined
        const tags = Array.isArray(body.tags) ? body.tags as string[] : undefined
        const validVisibility = ['private', 'shared', 'public']
        const validLifecycle = ['ephemeral', 'persistent']
        if (visibility && !validVisibility.includes(visibility)) {
          return json(res, { error: 'Invalid visibility value' }, 400, origin)
        }
        if (lifecycle && !validLifecycle.includes(lifecycle)) {
          return json(res, { error: 'Invalid lifecycle value' }, 400, origin)
        }
        const result = updateTeamVisibility(
          teamId,
          visibility as Parameters<typeof updateTeamVisibility>[1],
          lifecycle as Parameters<typeof updateTeamVisibility>[2],
          tags,
        )
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
      if (method === 'DELETE') {
        const result = await disbandTeam(teamId, 'manual')
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
    }

    // Add agent to team: POST /api/ensemble/teams/:id/agents
    const addAgentMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/agents$/)
    if (addAgentMatch && method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
      }
      const program = body.program
      if (typeof program !== 'string' || !program.trim()) {
        return json(res, { error: 'Bad Request: "program" must be a non-empty string' }, 400, origin)
      }
      const role = typeof body.role === 'string' ? body.role : undefined
      const result = await addAgentToTeam(addAgentMatch[1], program.trim(), role)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Update team config: PATCH /api/ensemble/teams/:id/config
    const configMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/config$/)
    if (configMatch && method === 'PATCH') {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
      }

      const teamId = configMatch[1]
      const team = getTeam(teamId)
      if (!team) return json(res, { error: 'Team not found' }, 404, origin)

      // Merge incoming config with existing config
      const existingConfig = team.config || {}
      const newConfig: Record<string, unknown> = { ...existingConfig }
      const allowedKeys = ['maxTurns', 'timeoutMs', 'nudgeAfterMs', 'stallAfterMs', 'completionWindowMs', 'singleSignalIdleMs']
      for (const key of allowedKeys) {
        if (key in body) {
          const value = Number(body[key])
          if (Number.isFinite(value) && value >= 0) {
            newConfig[key] = value
          }
        }
      }

      const updated = updateTeam(teamId, { config: newConfig as TeamConfig })
      if (!updated) return json(res, { error: 'Failed to update team config' }, 500, origin)

      return json(res, { config: updated.config }, 200, origin)
    }

    // Clone/restart team: POST /api/ensemble/teams/:id/clone
    const cloneMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/clone$/)
    if (cloneMatch && method === 'POST') {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) } catch { /* empty body OK */ }
      const result = await cloneTeam(cloneMatch[1], {
        seedMessages: body.seedMessages === true,
        workingDirectory: typeof body.workingDirectory === 'string' ? body.workingDirectory : undefined,
      })
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Export team output: POST /api/ensemble/teams/:id/export
    const exportMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/export$/)
    if (exportMatch && method === 'POST') {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) } catch { /* empty body OK */ }
      const format = (typeof body.format === 'string' ? body.format : 'prompt') as 'prompt' | 'json' | 'markdown'
      if (!['prompt', 'json', 'markdown'].includes(format)) {
        return json(res, { error: 'Bad Request: format must be "prompt", "json", or "markdown"' }, 400, origin)
      }
      const result = exportTeam(exportMatch[1], format)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Execute team plan: POST /api/ensemble/teams/:id/execute
    const executeMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/execute$/)
    if (executeMatch && method === 'POST') {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) } catch { /* empty body OK */ }
      const agents = Array.isArray(body.agents)
        ? (body.agents as Array<{ program: string; role?: string }>).filter(
            a => typeof a.program === 'string' && a.program.trim(),
          )
        : []
      const workingDirectory = typeof body.workingDirectory === 'string' ? body.workingDirectory : undefined
      const result = await executeTeam(executeMatch[1], { agents, workingDirectory })
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Plan step update: PATCH /api/ensemble/teams/:id/plan/:stepId
    const planStepMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/plan\/([^/]+)$/)
    if (planStepMatch && method === 'PATCH') {
      const teamId = planStepMatch[1]
      const stepId = planStepMatch[2]

      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
      }

      const status = body.status
      if (typeof status !== 'string' || !['pending', 'in-progress', 'done', 'skipped'].includes(status)) {
        return json(res, { error: 'Bad Request: "status" must be one of: pending, in-progress, done, skipped' }, 400, origin)
      }

      const teamResult = getEnsembleTeam(teamId)
      if (teamResult.error) return json(res, { error: teamResult.error }, teamResult.status, origin)

      const team = teamResult.data!.team
      if (!team.plan) {
        return json(res, { error: 'No plan exists for this team' }, 404, origin)
      }

      const stepIdx = team.plan.steps.findIndex(s => s.id === stepId)
      if (stepIdx === -1) {
        return json(res, { error: `Step "${stepId}" not found` }, 404, origin)
      }

      const updatedSteps = [...team.plan.steps]
      updatedSteps[stepIdx] = {
        ...updatedSteps[stepIdx],
        status: status as 'pending' | 'in-progress' | 'done' | 'skipped',
        updatedAt: new Date().toISOString(),
      }

      const updatedPlan = { ...team.plan, steps: updatedSteps }
      updateTeam(teamId, { plan: updatedPlan })

      return json(res, { step: updatedSteps[stepIdx] }, 200, origin)
    }

    // Disband: /api/ensemble/teams/:id/disband
    const disbandMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/disband$/)
    if (disbandMatch && method === 'POST') {
      let reason: string = 'manual'
      try {
        const body = JSON.parse(await readBody(req))
        if (typeof body.reason === 'string') reason = body.reason
      } catch { /* empty body OK — default to manual */ }
      const result = await disbandTeam(disbandMatch[1], reason as 'completed' | 'manual' | 'error' | 'auto')
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Summarize team with AI agent: POST /api/ensemble/teams/:id/summarize
    // Spawns a temporary agent session, sends the summarize prompt, captures output.
    // Works with any backend agent (claude, codex, gemini, etc.) — no API key needed.
    const summarizeMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/summarize$/)
    if (summarizeMatch && method === 'POST') {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) } catch { /* empty body OK */ }

      const agentProgram = (typeof body.agent === 'string' && body.agent) || 'claude'

      const teamResult = getEnsembleTeam(summarizeMatch[1])
      if (teamResult.error) return json(res, { error: teamResult.error }, teamResult.status, origin)

      const team = teamResult.data!.team
      const allMessages = teamResult.data!.messages

      // Build summary prompt
      const agentMessages = allMessages.filter(m => m.from !== 'ensemble')
      const createdAt = new Date(team.createdAt).getTime()
      const endTime = team.completedAt ? new Date(team.completedAt).getTime() : Date.now()
      const durationMs = endTime - createdAt
      const durationMin = Math.max(0, Math.round(durationMs / 60000))
      const duration = durationMin >= 60
        ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
        : `${durationMin}m`

      const agentNames = team.agents.map(a => a.name).join(', ')
      const formattedMessages = agentMessages
        .slice(-50) // last 50 messages to stay within context
        .map(m => `${m.from}: ${m.content.slice(0, 500)}`)
        .join('\n')

      const summaryPrompt = `Summarize this AI agent collaboration in JSON format. Return ONLY valid JSON, no markdown fences.

{"task":"what the task was","decisions":["key decision 1","key decision 2"],"accomplished":["what was done 1","what was done 2"],"issues":["issue 1"],"filesChanged":["file1.ts","file2.ts"],"summary":"2-3 sentence overall summary"}

Team: ${team.name}
Task: ${team.description}
Duration: ${duration}
Agents: ${agentNames}
Messages:
${formattedMessages}`

      try {
        const { execFile } = await import('child_process')
        const { promisify } = await import('util')
        const execFileAsync = promisify(execFile)

        // Write prompt to a temp file to avoid shell escaping issues
        const promptFile = nodePath.join(os.tmpdir(), `ensemble-summary-${team.id.slice(0, 8)}.txt`)
        fs.writeFileSync(promptFile, summaryPrompt)

        // Use the agent's CLI in non-interactive/print mode
        let output: string
        const isWindows = os.platform() === 'win32'

        // Pipe the prompt via stdin to avoid CLI arg length limits
        // (SubFrame pattern: write to file, pipe to CLI, capture stdout)
        const { spawn: spawnChild } = await import('child_process')

        output = await new Promise<string>((resolve, reject) => {
          let stdout = ''
          let stderr = ''
          let cmd: string
          let args: string[]

          if (agentProgram.toLowerCase().includes('claude')) {
            cmd = 'claude'
            args = ['--print', '--output-format', 'text']
          } else if (agentProgram.toLowerCase().includes('codex')) {
            cmd = 'codex'
            args = ['exec']
          } else {
            reject(new Error(`Agent "${agentProgram}" does not support non-interactive summarization.`))
            return
          }

          const proc = spawnChild(cmd, args, {
            cwd: process.cwd(),
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: isWindows,
            timeout: 120000,
          })

          proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
          proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

          proc.on('close', (code) => {
            if (code === 0 || stdout.trim()) {
              resolve(stdout)
            } else {
              reject(new Error(`Agent exited with code ${code}: ${stderr.slice(0, 500)}`))
            }
          })

          proc.on('error', reject)

          // Write prompt to stdin and close
          proc.stdin?.write(summaryPrompt)
          proc.stdin?.end()
        })

        // Clean up temp file
        try { fs.unlinkSync(promptFile) } catch { /* ok */ }

        if (!output || !output.trim()) {
          return json(res, { error: 'Agent produced no output' }, 504, origin)
        }

        // Try to parse JSON from output, fall back to raw text
        const aiSummary = output.trim()
        let parsedSummary: string

        try {
          // Look for JSON object in the output
          const jsonMatch = aiSummary.match(/\{[\s\S]*"summary"[\s\S]*\}/)
          if (jsonMatch) {
            const obj = JSON.parse(jsonMatch[0])
            parsedSummary = obj.summary || aiSummary
            const existingResult = team.result || { summary: '', decisions: [], discoveries: [], filesChanged: [], duration: 0 }
            updateTeam(team.id, {
              result: {
                ...existingResult,
                aiSummary: obj.summary || aiSummary,
                decisions: obj.decisions || existingResult.decisions,
                discoveries: obj.accomplished || existingResult.discoveries,
                filesChanged: obj.filesChanged || existingResult.filesChanged,
              },
            })
          } else {
            throw new Error('no JSON')
          }
        } catch {
          parsedSummary = aiSummary
          const existingResult = team.result || { summary: '', decisions: [], discoveries: [], filesChanged: [], duration: 0 }
          updateTeam(team.id, {
            result: { ...existingResult, aiSummary: parsedSummary },
          })
        }

        return json(res, { aiSummary: parsedSummary, agent: agentProgram }, 200, origin)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return json(res, { error: `Failed to generate summary: ${message}` }, 500, origin)
      }
    }

    // Reopen team: POST /api/ensemble/teams/:id/reopen
    const reopenMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/reopen$/)
    if (reopenMatch && method === 'POST') {
      const result = await reopenTeam(reopenMatch[1])
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Permanent delete: DELETE /api/ensemble/teams/:id/purge
    const purgeMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/purge$/)
    if (purgeMatch && method === 'DELETE') {
      const result = deleteTeamPermanently(purgeMatch[1])
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Feed: /api/ensemble/teams/:id/feed
    const feedMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/feed$/)
    if (feedMatch && method === 'GET') {
      const since = url.searchParams.get('since') || undefined
      const result = getTeamFeed(feedMatch[1], since)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // SSE stream: /api/ensemble/teams/:id/stream
    const streamMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/stream$/)
    if (streamMatch && method === 'GET') {
      const teamId = streamMatch[1]

      // Validate team exists before opening the stream
      const teamResult = getEnsembleTeam(teamId)
      if (teamResult.error) return json(res, { error: teamResult.error }, teamResult.status, origin)

      // Build SSE headers, starting from CORS headers
      const sseHeaders = buildCorsHeaders(origin)
      sseHeaders['Content-Type'] = 'text/event-stream'
      sseHeaders['Cache-Control'] = 'no-cache'
      sseHeaders['Connection'] = 'keep-alive'

      res.writeHead(200, sseHeaders)

      // Send initial state
      const initData = teamResult.data
      res.write(`event: init\ndata: ${JSON.stringify(initData)}\n\n`)

      // Track the latest message timestamp for incremental polling
      let lastTimestamp: string | undefined
      const messages = initData!.messages
      if (messages.length > 0) {
        lastTimestamp = messages[messages.length - 1].timestamp
      }

      // Poll for new messages every 2 seconds
      let statsTick = 0
      const interval = setInterval(() => {
        const feedResult = getTeamFeed(teamId, lastTimestamp)
        if (feedResult.error) {
          // Team was deleted or errored — close the stream
          res.write(`event: error\ndata: ${JSON.stringify({ error: feedResult.error })}\n\n`)
          res.end()
          return
        }

        const newMessages = feedResult.data!.messages
        if (newMessages.length > 0) {
          lastTimestamp = newMessages[newMessages.length - 1].timestamp
          res.write(`event: message\ndata: ${JSON.stringify({ messages: newMessages })}\n\n`)
          // Clear typing indicators for senders of new messages
          const teamTyping = typingState.get(teamId)
          if (teamTyping) {
            for (const msg of newMessages) {
              if (teamTyping.has(msg.from)) {
                teamTyping.delete(msg.from)
                res.write(`event: typing_stop\ndata: ${JSON.stringify({ participant_id: msg.from, is_typing: false })}\n\n`)
              }
            }
          }
        }

        // Emit stats every 10s (every 5 polls)
        statsTick++
        if (statsTick % 5 === 0) {
          const currentTeam = getTeam(teamId)
          if (currentTeam) {
            const spectatorCount = [...activeSpectatorConnections].filter(c => c.teamId === teamId).length
            const allMsgs = getEnsembleTeam(teamId).data?.messages ?? []
            const elapsedMs = Date.now() - new Date(currentTeam.createdAt).getTime()
            res.write(`event: stats\ndata: ${JSON.stringify({
              spectator_count: spectatorCount,
              message_count: allMsgs.length,
              elapsed_ms: elapsedMs,
            })}\n\n`)
          }
        }

        // Check if team has been disbanded
        const currentTeam = getEnsembleTeam(teamId)
        if (currentTeam.data?.team.status === 'disbanded') {
          res.write(`event: disbanded\ndata: ${JSON.stringify({ team: currentTeam.data.team })}\n\n`)
          res.end()
        }
      }, 2000)
      interval.unref()

      const connection: SseConnection = { res, interval, teamId }
      activeSseConnections.add(connection)

      // Clean up on client disconnect
      req.on('close', () => {
        clearInterval(interval)
        activeSseConnections.delete(connection)
      })

      return
    }

    // SSE stream test page: /api/ensemble/teams/:id/stream/test
    const streamTestMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/stream\/test$/)
    if (streamTestMatch && method === 'GET') {
      const teamId = streamTestMatch[1]
      const html = `<!DOCTYPE html>
<html>
<head><title>SSE Test — Team ${teamId}</title></head>
<body>
<h1>SSE Stream Test — Team ${teamId}</h1>
<pre id="log"></pre>
<script>
const log = document.getElementById('log');
function append(text) { log.textContent += text + '\\n'; }
const es = new EventSource('/api/ensemble/teams/${teamId}/stream');
es.addEventListener('init', e => { append('[init] ' + e.data); });
es.addEventListener('message', e => { append('[message] ' + e.data); });
es.addEventListener('disbanded', e => { append('[disbanded] ' + e.data); es.close(); });
es.addEventListener('error', e => { append('[error] ' + (e.data || 'connection error')); });
es.onerror = () => { append('[onerror] EventSource connection lost'); };
</script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
      return
    }

    // -----------------------------------------------------------------------
    // Session interaction endpoints
    // -----------------------------------------------------------------------

    // List all active sessions: GET /api/ensemble/sessions
    if (path === '/api/ensemble/sessions' && method === 'GET') {
      const runtime = getRuntime()
      const sessions = await runtime.listSessions()
      return json(res, {
        sessions: sessions.map(s => ({
          name: s.name,
          exists: true,
          workingDirectory: s.workingDirectory,
        })),
      }, 200, origin)
    }

    // Session output: GET /api/ensemble/sessions/:name/output
    const sessionOutputMatch = path.match(/^\/api\/ensemble\/sessions\/([^/]+)\/output$/)
    if (sessionOutputMatch && method === 'GET') {
      const sessionName = sessionOutputMatch[1]
      if (!isValidSessionName(sessionName)) {
        return json(res, { error: 'Invalid session name' }, 400, origin)
      }

      const lines = Math.max(1, Math.min(10000, parseInt(url.searchParams.get('lines') || '200', 10) || 200))
      const runtime = getRuntime()
      const exists = await runtime.sessionExists(sessionName)

      if (!exists) {
        return json(res, { output: '', session: sessionName, exists: false }, 200, origin)
      }

      const output = await runtime.capturePane(sessionName, lines)
      return json(res, { output, session: sessionName, exists: true }, 200, origin)
    }

    // Session input: POST /api/ensemble/sessions/:name/input
    const sessionInputMatch = path.match(/^\/api\/ensemble\/sessions\/([^/]+)\/input$/)
    if (sessionInputMatch && method === 'POST') {
      const sessionName = sessionInputMatch[1]
      if (!isValidSessionName(sessionName)) {
        return json(res, { error: 'Invalid session name' }, 400, origin)
      }

      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
      }

      const text = body.text
      if (typeof text !== 'string') {
        return json(res, { error: 'Bad Request: "text" must be a string' }, 400, origin)
      }

      const enter = typeof body.enter === 'boolean' ? body.enter : false
      const literal = typeof body.literal === 'boolean' ? body.literal : true

      const runtime = getRuntime()
      const exists = await runtime.sessionExists(sessionName)
      if (!exists) {
        return json(res, { error: `Session "${sessionName}" not found` }, 404, origin)
      }

      await runtime.sendKeys(sessionName, text, { literal, enter })
      return json(res, { ok: true }, 200, origin)
    }

    // Session stream (SSE): GET /api/ensemble/sessions/:name/stream
    const sessionStreamMatch = path.match(/^\/api\/ensemble\/sessions\/([^/]+)\/stream$/)
    if (sessionStreamMatch && method === 'GET') {
      const sessionName = sessionStreamMatch[1]
      if (!isValidSessionName(sessionName)) {
        return json(res, { error: 'Invalid session name' }, 400, origin)
      }

      const runtime = getRuntime()
      const exists = await runtime.sessionExists(sessionName)
      if (!exists) {
        return json(res, { error: `Session "${sessionName}" not found` }, 404, origin)
      }

      // Build SSE headers, starting from CORS headers
      const sseHeaders = buildCorsHeaders(origin)
      sseHeaders['Content-Type'] = 'text/event-stream'
      sseHeaders['Cache-Control'] = 'no-cache'
      sseHeaders['Connection'] = 'keep-alive'

      res.writeHead(200, sseHeaders)

      // Strip ANSI escape codes for content comparison (avoids false diffs from cursor/color changes)
      const stripAnsiForCompare = (s: string) =>
        // eslint-disable-next-line no-control-regex
        s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[^[\]()][^\x1b]*/g, '')
         .replace(/\s+$/gm, '') // trim trailing whitespace per line

      // Send initial capture
      const initialOutput = await runtime.capturePane(sessionName, 500)
      res.write(`event: output\ndata: ${JSON.stringify({ output: initialOutput, timestamp: new Date().toISOString() })}\n\n`)

      let lastOutputHash = stripAnsiForCompare(initialOutput)
      let lastRawOutput = initialOutput

      // Poll every 2s — TUI agents update their status bars constantly,
      // so faster polling just causes flicker without adding information
      const interval = setInterval(async () => {
        try {
          const sessionStillExists = await runtime.sessionExists(sessionName)
          if (!sessionStillExists) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Session no longer exists' })}\n\n`)
            res.end()
            return
          }

          const currentOutput = await runtime.capturePane(sessionName, 500)
          const currentHash = stripAnsiForCompare(currentOutput)

          // Only send if the meaningful content changed (ignoring ANSI styling changes)
          if (currentHash !== lastOutputHash) {
            lastOutputHash = currentHash
            lastRawOutput = currentOutput
            res.write(`event: output\ndata: ${JSON.stringify({ output: currentOutput, timestamp: new Date().toISOString() })}\n\n`)
          }
        } catch {
          res.write(`event: error\ndata: ${JSON.stringify({ error: 'Failed to capture session output' })}\n\n`)
          res.end()
        }
      }, 2000)
      interval.unref()

      const connection: SessionSseConnection = { res, interval, sessionName }
      activeSessionSseConnections.add(connection)

      // Clean up on client disconnect
      req.on('close', () => {
        clearInterval(interval)
        activeSessionSseConnections.delete(connection)
      })

      return
    }

    // Serve static SPA files in production
    const webDistDir = nodePath.join(__dirname, 'web', 'dist')
    if (fs.existsSync(nodePath.join(webDistDir, 'index.html'))) {
      // Try to serve the file from web/dist
      const filePath = nodePath.join(webDistDir, url.pathname === '/' ? 'index.html' : url.pathname)
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = nodePath.extname(filePath)
        const mimeTypes: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' })
        fs.createReadStream(filePath).pipe(res)
        return
      }
      // SPA fallback: serve index.html for client-side routing
      res.writeHead(200, { 'Content-Type': 'text/html' })
      fs.createReadStream(nodePath.join(webDistDir, 'index.html')).pipe(res)
      return
    }

    json(res, { error: 'Not found' }, 404, origin)
  } catch (err) {
    console.error('[Server] Error:', err)
    json(res, { error: 'Internal server error' }, 500, origin)
  }
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`${color.brightRed}\u2717${color.reset} Port ${PORT} is already in use on ${HOST}. Stop the other process or set ENSEMBLE_PORT to a different port.`)
    process.exit(1)
  }

  console.error(`${color.brightRed}\u2717${color.reset} Server failed to start:`, err)
  process.exit(1)
})

// Track server start time for uptime calculation
;(server as unknown as { _ensembleStartTime: number })._ensembleStartTime = Date.now()

server.listen(PORT, HOST, () => {
  console.log(styledHeader('ensemble'))
  styledLog('\u2713', `Server running on http://${HOST}:${PORT}`)
  console.log(styledStatus('Health', `${color.dim}http://localhost:${PORT}/api/v1/health${color.reset}`))
  console.log()
})

// ---------------------------------------------------------------------------
// WebSocket PTY relay — replaces SSE-based session streaming
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  const match = url.pathname.match(/^\/api\/ensemble\/sessions\/([^/]+)\/ws$/)

  if (!match) {
    socket.destroy()
    return
  }

  const sessionName = match[1]
  // Validate session name
  if (!isValidSessionName(sessionName)) {
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    handleSessionWebSocket(ws, sessionName)
  })
})

async function handleSessionWebSocket(ws: WebSocket, sessionName: string) {
  const runtime = getRuntime()
  const exists = await runtime.sessionExists(sessionName)

  if (!exists) {
    ws.close(4004, 'Session not found')
    return
  }

  // For PtySessionManager: subscribe to raw PTY output
  if ('addDataListener' in runtime) {
    const ptyManager = runtime as import('./lib/pty-session-manager').PtySessionManager

    // Send initial buffer content
    const initialOutput = await runtime.capturePane(sessionName, 500)
    if (initialOutput) {
      ws.send(initialOutput)
    }

    // Subscribe to live PTY output
    const unsubscribe = ptyManager.addDataListener(sessionName, (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })

    // Receive input from client
    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString())
        if (data.type === 'input') {
          const session = ptyManager.getSession(sessionName)
          if (session) session.pty.write(data.text)
        } else if (data.type === 'resize') {
          const session = ptyManager.getSession(sessionName)
          if (session) session.pty.resize(data.cols, data.rows)
        }
      } catch {
        // Raw text input fallback
        const session = ptyManager.getSession(sessionName)
        if (session) session.pty.write(msg.toString())
      }
    })

    ws.on('close', () => {
      if (unsubscribe) unsubscribe()
    })
  } else {
    // TmuxRuntime fallback: poll capturePane (existing behavior but via WebSocket)
    const initialOutput = await runtime.capturePane(sessionName, 500)
    if (initialOutput) ws.send(initialOutput)

    let lastOutput = initialOutput
    const interval = setInterval(async () => {
      try {
        const output = await runtime.capturePane(sessionName, 500)
        if (output !== lastOutput) {
          lastOutput = output
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(output)
          }
        }
      } catch {
        ws.close(4000, 'Session capture failed')
      }
    }, 2000)

    ws.on('message', async (msg) => {
      try {
        const data = JSON.parse(msg.toString())
        if (data.type === 'input') {
          await runtime.sendKeys(sessionName, data.text, { literal: true, enter: data.enter || false })
        }
      } catch { /* ignore */ }
    })

    ws.on('close', () => clearInterval(interval))
  }
}
