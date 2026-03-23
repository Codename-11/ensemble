/**
 * EnsembleClient — Reusable data layer for ensemble team monitoring.
 *
 * Extracts the API communication and state management from the TUI monitor
 * so it can be shared between the CLI monitor and a future React SPA.
 *
 * Uses only Node.js built-ins (http, events) — no external dependencies.
 */

import { EventEmitter } from 'events'
import http from 'http'

// ─────────────────────────── TYPES ───────────────────────────────────────

export interface EnsembleAgent {
  name: string
  program: string
  role: string
  status: string
}

export interface EnsembleTeam {
  id: string
  name: string
  description: string
  status: string
  agents: EnsembleAgent[]
  createdAt: string
}

export interface EnsembleMessage {
  id: string
  from: string
  to: string
  content: string
  timestamp: string
  type: string
}

export interface EnsembleClientEvents {
  'team': (team: EnsembleTeam) => void
  'messages': (messages: EnsembleMessage[], newCount: number) => void
  'error': (error: Error) => void
  'connected': () => void
  'disconnected': () => void
  'disbanded': (team: EnsembleTeam) => void
}

// ─────────────────────────── HTTP HELPERS ────────────────────────────────

function apiGet<T>(url: string, apiBase: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const full = new URL(url, apiBase)
    http.get(full.toString(), { timeout: 5000 }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

function apiPost<T>(url: string, body: unknown, apiBase: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const full = new URL(url, apiBase)
    const payload = JSON.stringify(body)
    const req = http.request(full.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000,
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ─────────────────────────── CLIENT ─────────────────────────────────────

const DEFAULT_API_BASE = 'http://localhost:23000'
const DEFAULT_POLL_INTERVAL_MS = 2000
const MAX_MESSAGES = 1000

export class EnsembleClient extends EventEmitter {
  private team: EnsembleTeam | null = null
  private messages: EnsembleMessage[] = []
  private lastSeenTimestamp: string | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private connected = false
  readonly teamId: string
  readonly apiBase: string

  constructor(teamId: string, apiBase?: string) {
    super()
    this.teamId = teamId
    this.apiBase = apiBase || process.env.ENSEMBLE_URL || DEFAULT_API_BASE
  }

  // ─── Public read-only accessors ────────────────────────────────────

  getTeam(): EnsembleTeam | null {
    return this.team
  }

  getMessages(): EnsembleMessage[] {
    return this.messages
  }

  isConnected(): boolean {
    return this.connected
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Start polling the ensemble server. Emits 'connected' once the first
   * successful fetch completes, then 'team' and 'messages' on every poll.
   */
  start(pollIntervalMs?: number): void {
    const interval = pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

    // Kick off an initial fetch immediately (non-blocking — errors go to 'error' event)
    this.poll()

    this.pollTimer = setInterval(() => this.poll(), interval)
  }

  /** Stop polling and clean up. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  // ─── Actions ───────────────────────────────────────────────────────

  async sendMessage(content: string, target?: string): Promise<void> {
    await apiPost(
      `/api/ensemble/teams/${this.teamId}`,
      { from: 'user', to: target || 'team', content },
      this.apiBase,
    )
    // Immediately fetch so the caller sees the message in the next getMessages()
    await this.fetchMessages()
  }

  async disbandTeam(): Promise<void> {
    // Fetch final messages before disbanding
    await this.fetchMessages()
    await apiPost(
      `/api/ensemble/teams/${this.teamId}/disband`,
      {},
      this.apiBase,
    )
    // Re-fetch team so status reflects 'disbanded'
    await this.fetchTeam()
    if (this.team) {
      this.emit('disbanded', this.team)
    }
  }

  // ─── Static helpers ────────────────────────────────────────────────

  /**
   * Fetch the list of teams and return the ID of the most recent active one.
   * Returns `null` if there are no active or forming teams.
   */
  static async resolveLatestTeamId(apiBase?: string): Promise<string | null> {
    const base = apiBase || process.env.ENSEMBLE_URL || DEFAULT_API_BASE
    const data = await apiGet<{ teams: EnsembleTeam[] }>('/api/ensemble/teams', base)
    const active = data.teams.filter(t => t.status === 'active' || t.status === 'forming')
    if (active.length === 0) return null
    return active[active.length - 1].id
  }

  /**
   * Fetch all teams (useful for team picker UIs).
   */
  static async fetchTeams(apiBase?: string): Promise<EnsembleTeam[]> {
    const base = apiBase || process.env.ENSEMBLE_URL || DEFAULT_API_BASE
    const data = await apiGet<{ teams: EnsembleTeam[] }>('/api/ensemble/teams', base)
    return data.teams
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      await this.fetchTeam()
      await this.fetchMessages()

      if (!this.connected) {
        this.connected = true
        this.emit('connected')
      }
    } catch (err) {
      const wasConnected = this.connected
      this.connected = false
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
      if (wasConnected) {
        this.emit('disconnected')
      }
    }
  }

  private async fetchTeam(): Promise<void> {
    const data = await apiGet<{ team: EnsembleTeam }>(
      `/api/ensemble/teams/${this.teamId}`,
      this.apiBase,
    )
    this.team = data.team
    this.emit('team', this.team)
  }

  private async fetchMessages(): Promise<void> {
    const sinceParam = this.lastSeenTimestamp
      ? `?since=${encodeURIComponent(this.lastSeenTimestamp)}`
      : ''
    const data = await apiGet<{ messages: EnsembleMessage[] }>(
      `/api/ensemble/teams/${this.teamId}/feed${sinceParam}`,
      this.apiBase,
    )
    const newMessages = data.messages || []
    const newCount = newMessages.length

    if (this.lastSeenTimestamp && newMessages.length > 0) {
      // Incremental: append only new messages
      this.messages.push(...newMessages)
    } else if (!this.lastSeenTimestamp) {
      // Initial fetch: take all
      this.messages = newMessages
    }

    // Update cursor to latest timestamp
    if (this.messages.length > 0) {
      this.lastSeenTimestamp = this.messages[this.messages.length - 1].timestamp
    }

    // Cap buffer to prevent unbounded growth
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES)
    }

    this.emit('messages', this.messages, newCount)
  }
}
