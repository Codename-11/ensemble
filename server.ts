/**
 * Agent-Forge Server — Standalone HTTP server
 * Lightweight replacement for Next.js API routes.
 */

import fs from 'fs'
import os from 'os'
import nodePath from 'path'
import { fileURLToPath } from 'url'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import {
  createAgentForgeTeam, getAgentForgeTeam, listAgentForgeTeams,
  getTeamFeed, sendTeamMessage, disbandTeam, deleteTeamPermanently, reopenTeam,
  addAgentToTeam, cloneTeam, exportTeam, executeTeam, listCollabTemplates,
  joinTeam, sendRemoteMessage, leaveTeam, kickParticipant,
  updateTeamVisibility, generateShareLink, getLobbyTeams,
  validateSessionToken, setSpectatorCountFn,
} from './services/agent-forge-service'
import { getTeam, updateTeam } from './lib/agent-forge-registry'
import type { TeamConfig } from './types/agent-forge'
import { getRuntime } from './lib/agent-runtime'
import { color, styledHeader, styledLog, styledStatus } from './lib/cli-style'
import {
  validateSession as validateAuthSession,
  createSession as createAuthSession,
  destroySession as destroyAuthSession,
  getUser, createUser, listUsers,
  verifyPassword,
  ensureAdminUser,
  parseCookies,
  buildSessionCookie,
  buildClearSessionCookie,
  cleanExpiredSessions,
  destroyAllUserSessions,
} from './lib/auth'

const __filename = fileURLToPath(import.meta.url)
const __dirname = nodePath.dirname(__filename)

const PORT = parseInt(process.env.AGENT_FORGE_PORT || '23000', 10)
const HOST = process.env.AGENT_FORGE_HOST || '127.0.0.1'
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

// Login-specific rate limiter: 5 attempts per minute per IP
const loginRateLimitByIp = new Map<string, RateLimitEntry>()
const LOGIN_RATE_LIMIT_MAX = 5

function isLoginRateLimited(ip: string): boolean {
  const now = Date.now()
  const current = loginRateLimitByIp.get(ip)
  if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
    loginRateLimitByIp.set(ip, { count: 1, windowStart: now })
    return false
  }
  current.count++
  return current.count > LOGIN_RATE_LIMIT_MAX
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
  for (const [ip, entry] of loginRateLimitByIp) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      loginRateLimitByIp.delete(ip)
    }
  }
}, 60_000)

function getAllowedCorsOrigins(): string[] {
  const configured = process.env.AGENT_FORGE_CORS_ORIGIN?.trim()
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

  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Credentials'] = 'true'
  } else if (isPublicEndpoint && process.env.AGENT_FORGE_PUBLIC_CORS === 'true') {
    headers['Access-Control-Allow-Origin'] = '*'
    // Do NOT set credentials with wildcard origin
  }

  return headers
}

function json(res: http.ServerResponse, data: unknown, status = 200, origin?: string, extraHeaders?: Record<string, string>) {
  const headers = buildCorsHeaders(origin)
  if (extraHeaders) Object.assign(headers, extraHeaders)
  res.writeHead(status, headers)
  res.end(JSON.stringify(data))
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function getAuthUser(req: http.IncomingMessage): { userId: string; username: string; displayName: string | null; role: string } | null {
  const cookies = parseCookies(req.headers.cookie || '')
  const token = cookies['agent-forge-session']
  if (!token) return null
  return validateAuthSession(token)
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse, origin?: string): boolean {
  const user = getAuthUser(req)
  if (!user) {
    json(res, { error: 'Authentication required' }, 401, origin)
    return false
  }
  return true
}

function requireAdmin(req: http.IncomingMessage, res: http.ServerResponse, origin?: string): boolean {
  const user = getAuthUser(req)
  if (!user) {
    json(res, { error: 'Authentication required' }, 401, origin)
    return false
  }
  if (user.role !== 'admin') {
    json(res, { error: 'Admin role required' }, 403, origin)
    return false
  }
  return true
}

function routeMatches(path: string, route: string): boolean {
  return path === `/api/agent-forge${route}`
}

function routeMatch(path: string, routePattern: RegExp): RegExpMatchArray | null {
  return path.match(new RegExp(`^/api/agent-forge${routePattern.source}`))
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
  // Only trust X-Forwarded-For when explicitly configured behind a known proxy
  if (process.env.AGENT_FORGE_TRUST_PROXY === 'true') {
    const forwardedFor = req.headers['x-forwarded-for']
    if (typeof forwardedFor === 'string') {
      const firstIp = forwardedFor.split(',')[0]?.trim()
      if (firstIp) return firstIp
    }
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

    // Serve SKILL.md as raw text — agents can read this URL for project knowledge
    if (path === '/api/agent-forge/skill.md' && method === 'GET') {
      try {
        const skillPath = nodePath.join(__dirname, 'SKILL.md')
        if (fs.existsSync(skillPath)) {
          const content = fs.readFileSync(skillPath, 'utf-8')
          const headers = buildCorsHeaders(origin, true) // public, any agent can read
          headers['Content-Type'] = 'text/markdown; charset=utf-8'
          res.writeHead(200, headers)
          res.end(content)
          return
        }
      } catch { /* fall through */ }
      return json(res, { error: 'SKILL.md not found' }, 404, origin)
    }

    // -----------------------------------------------------------------------
    // Auth endpoints
    // -----------------------------------------------------------------------

    // POST /api/agent-forge/auth/login — authenticate and set session cookie
    if (path === '/api/agent-forge/auth/login' && method === 'POST') {
      if (isLoginRateLimited(getClientIp(req))) {
        return json(res, { error: 'Too many login attempts. Try again later.' }, 429, origin)
      }

      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
      }

      const username = typeof body.username === 'string' ? body.username.trim() : ''
      const password = typeof body.password === 'string' ? body.password : ''

      if (!username || !password) {
        return json(res, { error: 'Username and password are required' }, 400, origin)
      }

      const user = getUser(username)
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return json(res, { error: 'Invalid username or password' }, 401, origin)
      }

      const session = createAuthSession(user.id)
      return json(
        res,
        { user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } },
        200,
        origin,
        { 'Set-Cookie': buildSessionCookie(session.token) }
      )
    }

    // POST /api/agent-forge/auth/logout — destroy session and clear cookie
    if (path === '/api/agent-forge/auth/logout' && method === 'POST') {
      const cookies = parseCookies(req.headers.cookie || '')
      const token = cookies['agent-forge-session']
      if (token) {
        destroyAuthSession(token)
      }
      return json(
        res,
        { ok: true },
        200,
        origin,
        { 'Set-Cookie': buildClearSessionCookie() }
      )
    }

    // POST /api/agent-forge/auth/logout-all — destroy all sessions for current user
    if (path === '/api/agent-forge/auth/logout-all' && method === 'POST') {
      const user = getAuthUser(req)
      if (!user) return json(res, { error: 'Not authenticated' }, 401, origin)
      destroyAllUserSessions(user.userId)
      return json(
        res,
        { ok: true, message: 'All sessions revoked' },
        200,
        origin,
        { 'Set-Cookie': buildClearSessionCookie() }
      )
    }

    // GET /api/agent-forge/auth/me — return current user from session cookie
    if (path === '/api/agent-forge/auth/me' && method === 'GET') {
      const user = getAuthUser(req)
      if (!user) {
        return json(res, { error: 'Not authenticated' }, 401, origin)
      }
      return json(res, { user: { id: user.userId, username: user.username, displayName: user.displayName, role: user.role } }, 200, origin)
    }

    // POST /api/agent-forge/auth/register — create new user (admin only, or first user)
    if (path === '/api/agent-forge/auth/register' && method === 'POST') {
      // Allow first user creation without auth; otherwise require admin
      const existingUsers = listUsers()
      if (existingUsers.length > 0) {
        const currentUser = getAuthUser(req)
        if (!currentUser || currentUser.role !== 'admin') {
          return json(res, { error: 'Only admins can register new users' }, 403, origin)
        }
      }

      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
      }

      const username = typeof body.username === 'string' ? body.username.trim() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : undefined

      if (!username || !password) {
        return json(res, { error: 'Username and password are required' }, 400, origin)
      }

      if (username.length < 3 || username.length > 32) {
        return json(res, { error: 'Username must be 3-32 characters' }, 400, origin)
      }

      if (password.length < 8) {
        return json(res, { error: 'Password must be at least 8 characters' }, 400, origin)
      }

      try {
        const newUser = createUser(username, password, displayName)
        return json(res, { user: { id: newUser.id, username: newUser.username } }, 201, origin)
      } catch (err: unknown) {
        // Let the UNIQUE constraint handle race conditions (TOCTOU-safe)
        if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return json(res, { error: 'Username already exists' }, 409, origin)
        }
        return json(res, { error: 'Failed to create user' }, 500, origin)
      }
    }

    // -----------------------------------------------------------------------

    // Server info — cwd, available agents, recent project dirs
    if (path === '/api/agent-forge/info' && method === 'GET') {
      if (!requireAuth(req, res, origin)) return

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

      const mcpServerPath = nodePath.resolve(__dirname, 'mcp', 'agent-forge-mcp-server.mjs')

      // Scan AGENT_FORGE_PROJECTS_DIR for project subdirectories
      const projectDirectories: Array<{ name: string; path: string }> = []
      const projectsDir = process.env.AGENT_FORGE_PROJECTS_DIR
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
          // AGENT_FORGE_PROJECTS_DIR not readable — return empty array
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

    // GET /api/agent-forge/config — return current server configuration
    if (routeMatches(path, '/config') && method === 'GET') {
      if (!requireAdmin(req, res, origin)) return

      const { loadAgentsConfig: loadAgents } = await import('./lib/agent-config')
      const { getAgentForgeDataDir } = await import('./lib/agent-forge-paths')
      const { getCollabRuntimeRoot } = await import('./lib/collab-paths')
      const { DEFAULT_NUDGE_MS, DEFAULT_STALL_MS, DEFAULT_POLL_INTERVAL_MS } = await import('./lib/agent-watchdog')
      const agentsConfig = loadAgents()
      const startTime = (server as unknown as { _agentForgeStartTime?: number })._agentForgeStartTime ?? Date.now()

      return json(res, {
        port: PORT,
        host: HOST,
        commMode: process.env.AGENT_FORGE_COMM_MODE || 'mcp',
        autoSummary: process.env.AGENT_FORGE_AUTO_SUMMARY !== 'false',
        watchdog: {
          nudgeMs: parseInt(process.env.AGENT_FORGE_WATCHDOG_NUDGE_MS || '', 10) || DEFAULT_NUDGE_MS,
          stallMs: parseInt(process.env.AGENT_FORGE_WATCHDOG_STALL_MS || '', 10) || DEFAULT_STALL_MS,
          pollMs: DEFAULT_POLL_INTERVAL_MS,
        },
        completion: {
          windowMs: 60_000,
          singleSignalIdleMs: 120_000,
        },
        agents: agentsConfig,
        dataDir: getAgentForgeDataDir(),
        runtimeDir: getCollabRuntimeRoot(),
        about: {
          version: '1.0.0',
          nodeVersion: process.version,
          platform: os.platform(),
          uptime: Math.floor((Date.now() - startTime) / 1000),
        },
      }, 200, origin)
    }

    // PATCH /api/agent-forge/config — update runtime-modifiable settings
    if (routeMatches(path, '/config') && method === 'PATCH') {
      if (!requireAdmin(req, res, origin)) return

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
          process.env.AGENT_FORGE_COMM_MODE = val
          updated.commMode = val
        } else {
          return json(res, { error: 'Bad Request: commMode must be "mcp" or "shell"' }, 400, origin)
        }
      }

      // autoSummary: boolean
      if ('autoSummary' in body) {
        const val = body.autoSummary
        if (typeof val === 'boolean') {
          process.env.AGENT_FORGE_AUTO_SUMMARY = val ? 'true' : 'false'
          updated.autoSummary = val
        } else {
          return json(res, { error: 'Bad Request: autoSummary must be a boolean' }, 400, origin)
        }
      }

      // watchdog nudgeMs
      if ('watchdogNudgeMs' in body) {
        const val = Number(body.watchdogNudgeMs)
        if (Number.isFinite(val) && val > 0) {
          process.env.AGENT_FORGE_WATCHDOG_NUDGE_MS = String(val)
          updated.watchdogNudgeMs = val
        } else {
          return json(res, { error: 'Bad Request: watchdogNudgeMs must be a positive number' }, 400, origin)
        }
      }

      // watchdog stallMs
      if ('watchdogStallMs' in body) {
        const val = Number(body.watchdogStallMs)
        if (Number.isFinite(val) && val > 0) {
          process.env.AGENT_FORGE_WATCHDOG_STALL_MS = String(val)
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
    if (routeMatches(path, '/teams')) {
      if (method === 'GET') {
        const result = listAgentForgeTeams()
        return json(res, result.data, result.status, origin)
      }
      if (method === 'POST') {
        if (!requireAuth(req, res, origin)) return

        let body: unknown
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
        const result = await createAgentForgeTeam(body as Parameters<typeof createAgentForgeTeam>[0])
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
    }

    // ── Lobby: GET /api/agent-forge/lobby ──────────────────────────────
    if (routeMatches(path, '/lobby') && method === 'GET') {
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

    // POST /api/agent-forge/teams/:id/join
    const joinMatch = routeMatch(path, /\/teams\/([^/]+)\/join$/)
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

    // POST /api/agent-forge/teams/:id/messages (remote participant send)
    const remoteMessageMatch = routeMatch(path, /\/teams\/([^/]+)\/messages$/)
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

    // POST /api/agent-forge/teams/:id/leave
    const leaveMatch = routeMatch(path, /\/teams\/([^/]+)\/leave$/)
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

    // DELETE /api/agent-forge/teams/:id/participants/:pid (kick)
    const kickMatch = routeMatch(path, /\/teams\/([^/]+)\/participants\/([^/]+)$/)
    if (kickMatch && method === 'DELETE') {
      if (!requireAuth(req, res, origin)) return
      const [, teamId, participantId] = kickMatch
      const result = kickParticipant(teamId, participantId)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // POST /api/agent-forge/teams/:id/share
    const shareMatch = routeMatch(path, /\/teams\/([^/]+)\/share$/)
    if (shareMatch && method === 'POST') {
      if (!requireAuth(req, res, origin)) return
      const teamId = shareMatch[1]
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) } catch { /* empty ok */ }
      const expiresIn = typeof body.expiresIn === 'string' ? body.expiresIn : undefined
      const result = generateShareLink(teamId, expiresIn)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // GET /api/agent-forge/teams/:id/spectate (SSE, no auth for public; token for shared)
    const spectateMatch = routeMatch(path, /\/teams\/([^/]+)\/spectate$/)
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
      const teamResult = getAgentForgeTeam(teamId)
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
            const allMsgs = getAgentForgeTeam(teamId).data?.messages ?? []
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

    // POST /api/agent-forge/teams/:id/typing — broadcast typing indicator
    const typingMatch = routeMatch(path, /\/teams\/([^/]+)\/typing$/)
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

    // GET /api/agent-forge/teams/:id/replay — full history for disbanded teams
    const replayMatch = routeMatch(path, /\/teams\/([^/]+)\/replay$/)
    if (replayMatch && method === 'GET') {
      const teamId = replayMatch[1]
      const teamResult = getAgentForgeTeam(teamId)
      if (teamResult.error) return json(res, { error: teamResult.error }, teamResult.status, origin)
      const teamData = teamResult.data!
      return json(res, {
        team: stripSensitiveFields({ ...teamData.team }),
        messages: teamData.messages,
        replayUrl: `/replay/${teamId}`,
      }, 200, origin)
    }

    // Team operations: /api/agent-forge/teams/:id
    const teamMatch = routeMatch(path, /\/teams\/([^/]+)$/)
    if (teamMatch) {
      const teamId = teamMatch[1]
      if (method === 'GET') {
        const result = getAgentForgeTeam(teamId)
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        const safeData = result.data ? { ...result.data, team: stripSensitiveFields({ ...result.data.team }) } : result.data
        return json(res, safeData, result.status, origin)
      }
      if (method === 'POST') {
        if (!requireAuth(req, res, origin)) return

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
        if (!requireAuth(req, res, origin)) return

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
        if (!requireAuth(req, res, origin)) return

        const result = await disbandTeam(teamId, 'manual')
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
    }

    // Add agent to team: POST /api/agent-forge/teams/:id/agents
    const addAgentMatch = routeMatch(path, /\/teams\/([^/]+)\/agents$/)
    if (addAgentMatch && method === 'POST') {
      if (!requireAuth(req, res, origin)) return
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

    // Update team config: PATCH /api/agent-forge/teams/:id/config
    const configMatch = routeMatch(path, /\/teams\/([^/]+)\/config$/)
    if (configMatch && method === 'PATCH') {
      if (!requireAuth(req, res, origin)) return

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

    // Clone/restart team: POST /api/agent-forge/teams/:id/clone
    const cloneMatch = routeMatch(path, /\/teams\/([^/]+)\/clone$/)
    if (cloneMatch && method === 'POST') {
      if (!requireAuth(req, res, origin)) return
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) } catch { /* empty body OK */ }
      const result = await cloneTeam(cloneMatch[1], {
        seedMessages: body.seedMessages === true,
        workingDirectory: typeof body.workingDirectory === 'string' ? body.workingDirectory : undefined,
      })
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Export team output: POST /api/agent-forge/teams/:id/export
    const exportMatch = routeMatch(path, /\/teams\/([^/]+)\/export$/)
    if (exportMatch && method === 'POST') {
      if (!requireAuth(req, res, origin)) return
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

    // Execute team plan: POST /api/agent-forge/teams/:id/execute
    const executeMatch = routeMatch(path, /\/teams\/([^/]+)\/execute$/)
    if (executeMatch && method === 'POST') {
      if (!requireAuth(req, res, origin)) return
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

    // Plan step update: PATCH /api/agent-forge/teams/:id/plan/:stepId
    const planStepMatch = routeMatch(path, /\/teams\/([^/]+)\/plan\/([^/]+)$/)
    if (planStepMatch && method === 'PATCH') {
      if (!requireAuth(req, res, origin)) return
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

      const teamResult = getAgentForgeTeam(teamId)
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

    // Disband: /api/agent-forge/teams/:id/disband
    const disbandMatch = routeMatch(path, /\/teams\/([^/]+)\/disband$/)
    if (disbandMatch && method === 'POST') {
      if (!requireAuth(req, res, origin)) return

      let reason: string = 'manual'
      try {
        const body = JSON.parse(await readBody(req))
        if (typeof body.reason === 'string') reason = body.reason
      } catch { /* empty body OK — default to manual */ }
      const result = await disbandTeam(disbandMatch[1], reason as 'completed' | 'manual' | 'error' | 'auto')
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Summarize team with AI agent: POST /api/agent-forge/teams/:id/summarize
    // Spawns a temporary agent session, sends the summarize prompt, captures output.
    // Works with any backend agent (claude, codex, gemini, etc.) — no API key needed.
    const summarizeMatch = routeMatch(path, /\/teams\/([^/]+)\/summarize$/)
    if (summarizeMatch && method === 'POST') {
      if (!requireAuth(req, res, origin)) return
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) } catch { /* empty body OK */ }

      const agentProgram = (typeof body.agent === 'string' && body.agent) || 'claude'

      const teamResult = getAgentForgeTeam(summarizeMatch[1])
      if (teamResult.error) return json(res, { error: teamResult.error }, teamResult.status, origin)

      const team = teamResult.data!.team
      const allMessages = teamResult.data!.messages

      // Build summary prompt
      const agentMessages = allMessages.filter(m => m.from !== 'agent-forge')
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
        const promptFile = nodePath.join(os.tmpdir(), `agent-forge-summary-${team.id.slice(0, 8)}.txt`)
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

    // Reopen team: POST /api/agent-forge/teams/:id/reopen
    const reopenMatch = routeMatch(path, /\/teams\/([^/]+)\/reopen$/)
    if (reopenMatch && method === 'POST') {
      if (!requireAuth(req, res, origin)) return
      const result = await reopenTeam(reopenMatch[1])
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Permanent delete: DELETE /api/agent-forge/teams/:id/purge
    const purgeMatch = routeMatch(path, /\/teams\/([^/]+)\/purge$/)
    if (purgeMatch && method === 'DELETE') {
      if (!requireAuth(req, res, origin)) return

      const result = deleteTeamPermanently(purgeMatch[1])
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Feed: /api/agent-forge/teams/:id/feed
    const feedMatch = routeMatch(path, /\/teams\/([^/]+)\/feed$/)
    if (feedMatch && method === 'GET') {
      const since = url.searchParams.get('since') || undefined
      const result = getTeamFeed(feedMatch[1], since)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // SSE stream: /api/agent-forge/teams/:id/stream
    const streamMatch = routeMatch(path, /\/teams\/([^/]+)\/stream$/)
    if (streamMatch && method === 'GET') {
      const teamId = streamMatch[1]

      // Validate team exists before opening the stream
      const teamResult = getAgentForgeTeam(teamId)
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
            const allMsgs = getAgentForgeTeam(teamId).data?.messages ?? []
            const elapsedMs = Date.now() - new Date(currentTeam.createdAt).getTime()
            res.write(`event: stats\ndata: ${JSON.stringify({
              spectator_count: spectatorCount,
              message_count: allMsgs.length,
              elapsed_ms: elapsedMs,
            })}\n\n`)
          }
        }

        // Check if team has been disbanded
        const currentTeam = getAgentForgeTeam(teamId)
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

    // SSE stream test page: /api/agent-forge/teams/:id/stream/test
    const streamTestMatch = routeMatch(path, /\/teams\/([^/]+)\/stream\/test$/)
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
const es = new EventSource('/api/agent-forge/teams/${teamId}/stream');
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

    // List all active sessions: GET /api/agent-forge/sessions
    if (routeMatches(path, '/sessions') && method === 'GET') {
      if (!requireAuth(req, res, origin)) return

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

    // Session output: GET /api/agent-forge/sessions/:name/output
    const sessionOutputMatch = routeMatch(path, /\/sessions\/([^/]+)\/output$/)
    if (sessionOutputMatch && method === 'GET') {
      if (!requireAuth(req, res, origin)) return

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

    // Session input: POST /api/agent-forge/sessions/:name/input
    const sessionInputMatch = routeMatch(path, /\/sessions\/([^/]+)\/input$/)
    if (sessionInputMatch && method === 'POST') {
      if (!requireAuth(req, res, origin)) return

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

    // Session stream (SSE): GET /api/agent-forge/sessions/:name/stream
    const sessionStreamMatch = routeMatch(path, /\/sessions\/([^/]+)\/stream$/)
    if (sessionStreamMatch && method === 'GET') {
      if (!requireAuth(req, res, origin)) return

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

    // -----------------------------------------------------------------------
    // Deploy / Update endpoints
    // -----------------------------------------------------------------------

    // GET /api/agent-forge/deploy/status — current deployment info
    if (routeMatches(path, '/deploy/status') && method === 'GET') {
      if (!requireAdmin(req, res, origin)) return

      const { execSync: execSyncCmd } = await import('child_process')
      const projectRoot = __dirname
      const result: Record<string, unknown> = {
        commitHash: null,
        commitMessage: null,
        branch: null,
        lastDeployTime: null,
        serviceActive: false,
        serviceRunning: false,
        commitsBehind: 0,
        upToDate: true,
      }

      try {
        result.commitHash = execSyncCmd('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim()
      } catch { /* git not available */ }

      try {
        result.commitMessage = execSyncCmd('git log -1 --pretty=%s', { cwd: projectRoot, encoding: 'utf-8' }).trim()
      } catch { /* ignore */ }

      try {
        result.branch = execSyncCmd('git branch --show-current', { cwd: projectRoot, encoding: 'utf-8' }).trim()
      } catch { /* ignore */ }

      // Last deploy time from web/dist/index.html mtime
      try {
        const distIndex = nodePath.join(projectRoot, 'web', 'dist', 'index.html')
        const stat = fs.statSync(distIndex)
        result.lastDeployTime = stat.mtime.toISOString()
      } catch { /* dist not built yet */ }

      // Service status (Linux only)
      try {
        const status = execSyncCmd('systemctl --user is-active openclaw-agent-forge', { cwd: projectRoot, encoding: 'utf-8' }).trim()
        const isRunning = status === 'active'
        result.serviceActive = isRunning
        result.serviceRunning = isRunning
      } catch {
        result.serviceActive = false
        result.serviceRunning = false
      }

      // Commits behind origin/main
      try {
        // Check if origin/main ref exists
        execSyncCmd('git rev-parse --verify origin/main', { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe' })
        const behindOutput = execSyncCmd('git rev-list --count HEAD..origin/main', { cwd: projectRoot, encoding: 'utf-8' }).trim()
        const behind = parseInt(behindOutput, 10) || 0
        result.commitsBehind = behind
        result.upToDate = behind === 0
      } catch { /* origin/main not available */ }

      return json(res, result, 200, origin)
    }

    // POST /api/agent-forge/deploy/check — fetch and return diff info
    if (routeMatches(path, '/deploy/check') && method === 'POST') {
      if (!requireAdmin(req, res, origin)) return

      const { execSync: execSyncCmd } = await import('child_process')
      const projectRoot = __dirname

      try {
        execSyncCmd('git fetch origin main', { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe' })
      } catch (err) {
        return json(res, { error: 'Failed to fetch from origin: ' + (err instanceof Error ? err.message : String(err)) }, 500, origin)
      }

      let commitsBehind = 0
      const commits: Array<{ hash: string; message: string; author: string; date: string }> = []
      let filesChanged: string[] = []

      try {
        const behindOutput = execSyncCmd('git rev-list --count HEAD..origin/main', { cwd: projectRoot, encoding: 'utf-8' }).trim()
        commitsBehind = parseInt(behindOutput, 10) || 0
      } catch { /* ignore */ }

      try {
        const logOutput = execSyncCmd('git log --format=%H%n%s%n%an%n%aI HEAD..origin/main', { cwd: projectRoot, encoding: 'utf-8' }).trim()
        if (logOutput) {
          const lines = logOutput.split('\n')
          for (let i = 0; i + 3 < lines.length; i += 4) {
            commits.push({
              hash: lines[i],
              message: lines[i + 1],
              author: lines[i + 2],
              date: lines[i + 3],
            })
          }
        }
      } catch { /* ignore */ }

      try {
        const diffOutput = execSyncCmd('git diff --name-only HEAD..origin/main', { cwd: projectRoot, encoding: 'utf-8' }).trim()
        if (diffOutput) {
          filesChanged = diffOutput.split('\n').filter(Boolean)
        }
      } catch { /* ignore */ }

      return json(res, {
        commitsBehind,
        commits,
        filesChanged,
        upToDate: commitsBehind === 0,
      }, 200, origin)
    }

    // GET /api/agent-forge/deploy/run — execute full deploy with SSE streaming
    // Uses GET so EventSource can connect directly from the browser
    if (routeMatches(path, '/deploy/run') && (method === 'GET' || method === 'POST')) {
      if (!requireAdmin(req, res, origin)) return

      const { spawn: spawnDeploy } = await import('child_process')
      const projectRoot = __dirname
      const webDir = nodePath.join(projectRoot, 'web')
      const isWindows = os.platform() === 'win32'

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...buildCorsHeaders(origin),
      })

      const send = (event: string, data: string) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify({ message: data, timestamp: new Date().toISOString() })}\n\n`)
      }

      function runDeployCommand(cmd: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
        return new Promise((resolve) => {
          let output = ''
          const proc = spawnDeploy(cmd, args, { cwd, shell: true })
          proc.stdout?.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            output += text
            send('output', text.trim())
          })
          proc.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            output += text
            send('output', text.trim())
          })
          proc.on('close', (code) => resolve({ code: code ?? 1, output }))
        })
      }

      const steps: Array<{ message: string; cmd: string; args: string[]; cwd: string; optional?: boolean }> = [
        { message: 'Pulling latest changes...', cmd: 'git', args: ['pull', 'origin', 'main'], cwd: projectRoot },
        { message: 'Installing dependencies...', cmd: 'npm', args: ['install', '--silent'], cwd: projectRoot },
        { message: 'Installing web dependencies...', cmd: 'npm', args: ['install', '--silent'], cwd: webDir },
        { message: 'Building web app...', cmd: 'npm', args: ['run', 'build'], cwd: webDir },
      ]

      // systemctl restart is Linux-only
      if (!isWindows) {
        steps.push({
          message: 'Restarting service...',
          cmd: 'systemctl',
          args: ['--user', 'restart', 'openclaw-agent-forge'],
          cwd: projectRoot,
          optional: true,
        })
      } else {
        steps.push({
          message: 'Skipping service restart (Windows)...',
          cmd: 'echo',
          args: ['Service restart skipped on Windows'],
          cwd: projectRoot,
          optional: true,
        })
      }

      // Health check
      steps.push({
        message: 'Running health check...',
        cmd: 'curl',
        args: ['-s', `http://localhost:${PORT}/api/v1/health`],
        cwd: projectRoot,
        optional: true,
      })

      // --- Deploy history logging helpers ---
      const { getAgentForgeDataDir: getDataDir } = await import('./lib/agent-forge-paths')
      const historyPath = nodePath.join(getDataDir(), 'deploy-history.json')

      function readDeployHistory(): Array<Record<string, unknown>> {
        try {
          if (fs.existsSync(historyPath)) {
            return JSON.parse(fs.readFileSync(historyPath, 'utf-8'))
          }
        } catch { /* corrupted file */ }
        return []
      }

      function writeDeployHistory(entries: Array<Record<string, unknown>>): void {
        const dir = nodePath.dirname(historyPath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(historyPath, JSON.stringify(entries, null, 2))
      }

      // Create deploy history entry
      const deployId = `deploy-${Date.now()}`
      const deployStartTime = Date.now()
      let deployCommitHash = ''
      let deployCommitMessage = ''
      try {
        const { execSync: execSyncLog } = await import('child_process')
        deployCommitHash = execSyncLog('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim()
        deployCommitMessage = execSyncLog('git log -1 --pretty=%s', { cwd: projectRoot, encoding: 'utf-8' }).trim()
      } catch { /* ignore */ }

      const historyEntry: Record<string, unknown> = {
        id: deployId,
        timestamp: new Date().toISOString(),
        commitHash: deployCommitHash,
        commitMessage: deployCommitMessage,
        status: 'running',
        source: 'manual',
        duration: null,
        error: null,
      }

      // Append running entry
      const history = readDeployHistory()
      history.unshift(historyEntry)
      writeDeployHistory(history.slice(0, 50)) // keep max 50

      for (const step of steps) {
        send('step', step.message)
        const result = await runDeployCommand(step.cmd, step.args, step.cwd)
        if (result.code !== 0 && !step.optional) {
          send('error', `Step failed: ${step.message}\n${result.output}`)
          // Update history entry to failed
          const h = readDeployHistory()
          const entry = h.find((e) => e.id === deployId)
          if (entry) {
            entry.status = 'failed'
            entry.duration = Date.now() - deployStartTime
            entry.error = `Step failed: ${step.message}`
            writeDeployHistory(h)
          }
          res.end()
          return
        }
        if (result.code !== 0 && step.optional) {
          send('warning', `Step had issues but continuing: ${step.message}`)
        }
      }

      // Update history entry to success
      try {
        const { execSync: execSyncPost } = await import('child_process')
        const newHash = execSyncPost('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim()
        const newMsg = execSyncPost('git log -1 --pretty=%s', { cwd: projectRoot, encoding: 'utf-8' }).trim()
        const h = readDeployHistory()
        const entry = h.find((e) => e.id === deployId)
        if (entry) {
          entry.status = 'success'
          entry.duration = Date.now() - deployStartTime
          entry.commitHash = newHash
          entry.commitMessage = newMsg
          writeDeployHistory(h)
        }
      } catch {
        // Best effort - just mark success without updated hash
        const h = readDeployHistory()
        const entry = h.find((e) => e.id === deployId)
        if (entry) {
          entry.status = 'success'
          entry.duration = Date.now() - deployStartTime
          writeDeployHistory(h)
        }
      }

      send('done', 'Deploy complete!')
      res.end()
      return
    }

    // GET /api/agent-forge/deploy/history — past deploy history
    if (routeMatches(path, '/deploy/history') && method === 'GET') {
      if (!requireAdmin(req, res, origin)) return

      const { getAgentForgeDataDir: getDataDirHist } = await import('./lib/agent-forge-paths')
      const historyFilePath = nodePath.join(getDataDirHist(), 'deploy-history.json')

      let entries: Array<Record<string, unknown>> = []
      try {
        if (fs.existsSync(historyFilePath)) {
          entries = JSON.parse(fs.readFileSync(historyFilePath, 'utf-8'))
        }
      } catch { /* corrupted or missing */ }

      // Return last 20
      return json(res, entries.slice(0, 20), 200, origin)
    }

    // POST /api/agent-forge/deploy/rollback — rollback to a specific commit
    if (routeMatches(path, '/deploy/rollback') && method === 'POST') {
      if (!requireAdmin(req, res, origin)) return

      const { execSync: execSyncRb } = await import('child_process')
      const projectRoot = __dirname
      const webDir = nodePath.join(projectRoot, 'web')

      let body: { commitHash?: string }
      try {
        const raw = await readBody(req)
        body = JSON.parse(raw)
      } catch {
        return json(res, { error: 'Invalid JSON body' }, 400, origin)
      }

      const commitHash = body.commitHash
      if (!commitHash || typeof commitHash !== 'string' || !/^[a-f0-9]{6,40}$/i.test(commitHash)) {
        return json(res, { error: 'Invalid or missing commitHash' }, 400, origin)
      }

      const rollbackSteps: string[] = []
      const rollbackStartTime = Date.now()

      try {
        // 1. Stash local changes
        rollbackSteps.push('Stashing local changes...')
        try {
          execSyncRb('git stash', { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe' })
        } catch { /* nothing to stash */ }

        // 2. Checkout target commit
        rollbackSteps.push(`Checking out ${commitHash.slice(0, 7)}...`)
        execSyncRb(`git checkout ${commitHash}`, { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe' })

        // 3. Build web
        rollbackSteps.push('Building web app...')
        execSyncRb('npm run build', { cwd: webDir, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 })

        // 4. Restart service (Linux only)
        const isWindows = os.platform() === 'win32'
        if (!isWindows) {
          rollbackSteps.push('Restarting service...')
          try {
            execSyncRb('systemctl --user restart openclaw-agent-forge', { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe' })
          } catch { rollbackSteps.push('Service restart skipped (not available)') }
        } else {
          rollbackSteps.push('Skipping service restart (Windows)')
        }

        // Log rollback to deploy history
        const { getAgentForgeDataDir: getDataDirRb } = await import('./lib/agent-forge-paths')
        const rbHistoryPath = nodePath.join(getDataDirRb(), 'deploy-history.json')
        let rbHistory: Array<Record<string, unknown>> = []
        try {
          if (fs.existsSync(rbHistoryPath)) {
            rbHistory = JSON.parse(fs.readFileSync(rbHistoryPath, 'utf-8'))
          }
        } catch { /* ignore */ }

        let rbCommitMessage = ''
        try {
          rbCommitMessage = execSyncRb('git log -1 --pretty=%s', { cwd: projectRoot, encoding: 'utf-8' }).trim()
        } catch { /* ignore */ }

        rbHistory.unshift({
          id: `deploy-${Date.now()}`,
          timestamp: new Date().toISOString(),
          commitHash: commitHash,
          commitMessage: rbCommitMessage,
          status: 'success',
          source: 'rollback',
          duration: Date.now() - rollbackStartTime,
          error: null,
        })

        const rbDir = nodePath.dirname(rbHistoryPath)
        if (!fs.existsSync(rbDir)) fs.mkdirSync(rbDir, { recursive: true })
        fs.writeFileSync(rbHistoryPath, JSON.stringify(rbHistory.slice(0, 50), null, 2))

        return json(res, { success: true, commitHash, steps: rollbackSteps }, 200, origin)
      } catch (err) {
        return json(res, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          steps: rollbackSteps,
        }, 500, origin)
      }
    }

    // POST /api/agent-forge/deploy/webhook — placeholder for GitHub webhook integration
    if (routeMatches(path, '/deploy/webhook') && method === 'POST') {
      if (!requireAdmin(req, res, origin)) return

      res.writeHead(501, buildCorsHeaders(origin))
      res.end(JSON.stringify({ error: 'Not implemented yet — GitHub webhook integration is planned for a future release.' }))
      return
    }

    if (path.startsWith('/api/')) {
      return json(res, { error: 'Not found' }, 404, origin)
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
    console.error(`${color.brightRed}\u2717${color.reset} Port ${PORT} is already in use on ${HOST}. Stop the other process or set AGENT_FORGE_PORT to a different port.`)
    process.exit(1)
  }

  console.error(`${color.brightRed}\u2717${color.reset} Server failed to start:`, err)
  process.exit(1)
})

// Track server start time for uptime calculation
;(server as unknown as { _agentForgeStartTime: number })._agentForgeStartTime = Date.now()

server.listen(PORT, HOST, () => {
  console.log(styledHeader('agent-forge'))
  styledLog('\u2713', `Server running on http://${HOST}:${PORT}`)
  console.log(styledStatus('Health', `${color.dim}http://localhost:${PORT}/api/v1/health${color.reset}`))
  console.log()

  // Initialize auth: create default admin user if none exist
  try {
    ensureAdminUser()
    cleanExpiredSessions()
  } catch (err) {
    console.error('[Agent-Forge] Failed to initialize auth:', err)
  }
})

// ---------------------------------------------------------------------------
// WebSocket PTY relay — replaces SSE-based session streaming
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  const match = url.pathname.match(/^\/api\/agent-forge\/sessions\/([^/]+)\/ws$/)

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

  // Authenticate WebSocket upgrade via session cookie
  const cookies = parseCookies(req.headers.cookie || '')
  const token = cookies['agent-forge-session']
  const user = token ? validateAuthSession(token) : null
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
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
