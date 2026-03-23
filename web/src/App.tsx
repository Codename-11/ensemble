import { useState, useEffect, useCallback } from 'react'
import {
  Plus,
  Loader2,
  Users,
  Activity,
  ChevronRight,
  MessageCircle,
  Clock,
  Eye,
  Trash2,
  FileText,
  RotateCcw,
  FastForward,
  Settings,
} from 'lucide-react'
import { cn } from './lib/utils'
import type { EnsembleTeam, EnsembleTeamAgent } from './types'
import { useEnsemble } from './hooks/useEnsemble'
import { Monitor } from './components/Monitor'
import { LaunchForm } from './components/LaunchForm'
import { SettingsPage } from './components/SettingsPage'
import { useUIStore } from './stores/ui-store'

// ── Helpers ──────────────────────────────────────────────────

function timeAgo(isoString: string): string {
  const now = Date.now()
  const then = new Date(isoString).getTime()
  const seconds = Math.floor((now - then) / 1000)

  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Map an agent program name to a CSS agent color variable */
function agentColor(agent: EnsembleTeamAgent): string {
  const prog = agent.program.toLowerCase()
  if (prog.includes('codex')) return 'var(--agent-codex)'
  if (prog.includes('claude')) return 'var(--agent-claude)'
  if (prog.includes('gemini')) return 'var(--agent-gemini)'
  if (prog.includes('aider')) return 'var(--agent-aider)'
  return 'var(--agent-default)'
}

// ── Component ────────────────────────────────────────────────

export function App() {
  const activeView = useUIStore((s) => s.activeView)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const [teams, setTeams] = useState<EnsembleTeam[]>([])
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)
  const [loadingTeams, setLoadingTeams] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [showLaunchForm, setShowLaunchForm] = useState(false)
  const [hoveredTeamId, setHoveredTeamId] = useState<string | null>(null)
  const [serverOnline, setServerOnline] = useState(false)

  const { team, messages, connected, error, sendMessage, disbandTeam } = useEnsemble(selectedTeamId)

  // Clone a past team (restart fresh or continue with context)
  const handleCloneTeam = useCallback(async (sourceTeamId: string, seed: boolean) => {
    try {
      const res = await fetch(`/api/ensemble/teams/${sourceTeamId}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seedMessages: seed }),
      })
      if (!res.ok) return
      const data = await res.json()
      const newId: string = data.team?.id ?? data.id
      if (newId) setSelectedTeamId(newId)
    } catch { /* ignore */ }
  }, [])

  // Check URL hash for team ID on mount
  useEffect(() => {
    const hash = window.location.hash.replace('#', '')
    if (hash) setSelectedTeamId(hash)
  }, [])

  // Update URL hash when team changes
  useEffect(() => {
    if (selectedTeamId) {
      window.location.hash = selectedTeamId
    } else {
      window.location.hash = ''
    }
  }, [selectedTeamId])

  // Fetch team list
  const fetchTeams = useCallback(async () => {
    try {
      const res = await fetch('/api/ensemble/teams')
      if (!res.ok) {
        setListError(`Failed to load teams: ${res.status}`)
        setServerOnline(res.status !== 0)
        return
      }
      const data = await res.json()
      setTeams(data.teams ?? data)
      setListError(null)
      setServerOnline(true)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load teams')
      setServerOnline(false)
    } finally {
      setLoadingTeams(false)
    }
  }, [])

  // Poll team list when no team is selected
  useEffect(() => {
    if (selectedTeamId) return
    void fetchTeams()
    const interval = setInterval(() => void fetchTeams(), 10000)
    return () => clearInterval(interval)
  }, [selectedTeamId, fetchTeams])

  // ── Derived data ────────────────────────────────────────────

  const activeTeams = teams
    .filter(t => t.status === 'active' || t.status === 'forming')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  const pastTeams = teams
    .filter(t => t.status !== 'active' && t.status !== 'forming')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  const totalTeams = teams.length
  const activeCount = activeTeams.length

  // ── Settings view ───────────────────────────────────────────
  if (activeView === 'settings') {
    return (
      <div className="flex h-full max-h-screen flex-col overflow-hidden">
        <SettingsPage onBack={() => setActiveView('teams')} />
      </div>
    )
  }

  // ── Monitor view ────────────────────────────────────────────
  if (selectedTeamId && team) {
    return (
      <div className="flex h-full max-h-screen flex-col overflow-hidden">
        <Monitor
          team={team}
          messages={messages}
          connected={connected}
          error={error}
          onSend={sendMessage}
          onDisband={disbandTeam}
          onBack={() => setSelectedTeamId(null)}
          onNavigateToTeam={(id) => setSelectedTeamId(id)}
        />
      </div>
    )
  }

  // ── Team list view ──────────────────────────────────────────
  return (
    <div className="flex h-full max-h-screen flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="text-lg opacity-50">◈</span>
          <h1 className="text-lg font-semibold tracking-tight">ensemble</h1>
        </div>

        <div className="flex items-center gap-2 ml-3">
          {loadingTeams ? (
            <>
              <Loader2 className="size-3 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Connecting</span>
            </>
          ) : serverOnline ? (
            <>
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-green-500" />
              </span>
              <span className="text-xs text-muted-foreground">Server online</span>
            </>
          ) : (
            <>
              <span className="inline-block size-2 rounded-full bg-red-500" />
              <span className="text-xs text-destructive">Server offline</span>
            </>
          )}
        </div>

        {!loadingTeams && teams.length > 0 && (
          <span className="text-xs text-muted-foreground ml-2">
            {activeCount} active · {totalTeams} total
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => setActiveView('settings')}
            title="Settings"
          >
            <Settings className="size-4" />
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            onClick={() => setShowLaunchForm(true)}
          >
            <Plus className="size-3.5" />
            New Team
          </button>
        </div>
      </header>

      {/* Launch form modal */}
      {showLaunchForm && (
        <LaunchForm
          onLaunch={(id) => { setSelectedTeamId(id); setShowLaunchForm(false) }}
          onCancel={() => setShowLaunchForm(false)}
        />
      )}

      {/* Error banner */}
      {listError && (
        <div className="border-b border-destructive/20 bg-destructive/5 px-6 py-2 text-xs text-destructive">
          {listError}
        </div>
      )}

      {/* Content */}
      {loadingTeams ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
          <span className="text-sm">Loading teams...</span>
        </div>
      ) : teams.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
          <Users className="size-10 opacity-30" />
          <p className="text-sm font-medium">No teams yet</p>
          <div className="flex flex-col items-center gap-3 max-w-sm">
            <button
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              onClick={() => setShowLaunchForm(true)}
            >
              <Plus className="size-4" />
              Create your first team
            </button>
            <p className="text-center text-xs opacity-60">or from the command line:</p>
            <div className="w-full rounded-lg border border-border bg-card p-3 text-left">
              <p className="mb-2 text-[0.65rem] font-medium uppercase tracking-wider opacity-50">Quick start</p>
              <code className="block rounded bg-background px-2.5 py-1.5 font-mono text-xs text-foreground/80">
                ensemble run "your task" --agents codex,claude
              </code>
              <p className="mt-2 text-[0.65rem] font-medium uppercase tracking-wider opacity-50">Or via API</p>
              <code className="block rounded bg-background px-2.5 py-1.5 font-mono text-[0.65rem] text-foreground/80 break-all">
                curl -X POST localhost:23000/api/ensemble/teams -H "Content-Type: application/json" -d '{"{"}\"name\":\"my-team\",\"agents\":[{"{"}\"program\":\"codex\"{"}"},{"{"}\"program\":\"claude\"{"}"}]{"}"}'
              </code>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
        {/* ── Team list (left) ───────────────────────────────── */}
        <div className="flex flex-1 flex-col overflow-y-auto p-4 lg:p-6">
          {/* ── Active Teams Section ─────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Activity className="size-3.5 text-[var(--status-active)]" />
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Active Teams
              </h2>
              <span className="text-xs text-muted-foreground">({activeCount})</span>
            </div>

            {activeTeams.length === 0 ? (
              <div className="flex items-center justify-between rounded-lg border border-dashed border-border px-4 py-4">
                <p className="text-sm text-muted-foreground">No active teams</p>
                <button
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  onClick={() => setShowLaunchForm(true)}
                >
                  <Plus className="size-3" />
                  Launch
                </button>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {activeTeams.map(t => (
                  <li
                    key={t.id}
                    className="group relative flex cursor-pointer items-center justify-between rounded-lg border border-border bg-card p-3 transition-all hover:border-[var(--border-strong)] hover:bg-muted/30 lg:p-4 border-l-2 border-l-[var(--status-active)]"
                    onClick={() => setSelectedTeamId(t.id)}
                    onMouseEnter={() => setHoveredTeamId(t.id)}
                    onMouseLeave={() => setHoveredTeamId(null)}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      {/* Name + status badge */}
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{t.name}</span>
                        <span
                          className={cn(
                            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
                            `status-${t.status}`,
                          )}
                        >
                          {t.status}
                        </span>
                      </div>

                      {/* Task description (2-line clamp) */}
                      {t.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2 max-w-lg">
                          {t.description}
                        </p>
                      )}

                      {/* Agent avatars + metadata row */}
                      <div className="flex items-center gap-3 mt-0.5">
                        {/* Agent dots */}
                        <div className="flex items-center gap-1.5">
                          {t.agents.map(agent => (
                            <div
                              key={agent.name}
                              className="flex items-center gap-1"
                              title={`${agent.name} (${agent.program}) — ${agent.role === 'lead' ? 'Lead' : 'Worker'}`}
                            >
                              <span
                                className="inline-block size-2 rounded-full"
                                style={{ backgroundColor: agentColor(agent) }}
                              />
                              <span className="text-[10px] text-muted-foreground">
                                {agent.name}
                              </span>
                              {agent.role === 'lead' && (
                                <span className="text-[9px] text-muted-foreground/50">
                                  (Lead)
                                </span>
                              )}
                            </div>
                          ))}
                        </div>

                        {/* Separator */}
                        <span className="text-muted-foreground/30">·</span>

                        {/* Time ago */}
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Clock className="size-2.5" />
                          <span>{timeAgo(t.createdAt)}</span>
                        </div>

                        {/* Message count estimate */}
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <MessageCircle className="size-2.5" />
                          <span>{t.agents.length} agents</span>
                        </div>
                      </div>
                    </div>

                    {/* Right side: action + arrow */}
                    <div className="flex shrink-0 items-center gap-2 ml-3">
                      {hoveredTeamId === t.id && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary transition-opacity">
                          <Eye className="size-3" />
                          View
                        </span>
                      )}
                      <ChevronRight
                        className={cn(
                          'size-4 text-muted-foreground transition-transform',
                          hoveredTeamId === t.id && 'translate-x-0.5 text-foreground',
                        )}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Past Teams Separator + Section ───────────────── */}
          {pastTeams.length > 0 && (
            <section className="mt-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                  Past Teams
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <ul className="flex flex-col gap-1.5">
                {pastTeams.map(t => (
                  <li
                    key={t.id}
                    className="group relative flex cursor-pointer items-center justify-between rounded-lg border border-border/60 bg-card/50 p-2.5 transition-all hover:border-border hover:bg-muted/20 lg:p-3 opacity-70 hover:opacity-100"
                    onClick={() => setSelectedTeamId(t.id)}
                    onMouseEnter={() => setHoveredTeamId(t.id)}
                    onMouseLeave={() => setHoveredTeamId(null)}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {/* Name + status badge */}
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{t.name}</span>
                        <span
                          className={cn(
                            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
                            `status-${t.status}`,
                          )}
                        >
                          {t.status}
                        </span>
                      </div>

                      {/* Task description (2-line clamp) */}
                      {t.description && (
                        <p className="text-[11px] text-muted-foreground line-clamp-2 max-w-lg">
                          {t.description}
                        </p>
                      )}

                      {/* Agent dots + metadata */}
                      <div className="flex items-center gap-3 mt-0.5">
                        <div className="flex items-center gap-1">
                          {t.agents.map(agent => (
                            <span
                              key={agent.name}
                              className="inline-block size-1.5 rounded-full"
                              style={{ backgroundColor: agentColor(agent) }}
                              title={`${agent.name} (${agent.program}) — ${agent.role === 'lead' ? 'Lead' : 'Worker'}`}
                            />
                          ))}
                        </div>

                        <span className="text-muted-foreground/30">·</span>

                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Clock className="size-2.5" />
                          <span>{timeAgo(t.completedAt ?? t.createdAt)}</span>
                        </div>

                        {t.result && (
                          <>
                            <span className="text-muted-foreground/30">·</span>
                            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <FileText className="size-2.5" />
                              <span>{t.result.filesChanged.length} files changed</span>
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Right side: actions + arrow */}
                    <div className="flex shrink-0 items-center gap-1.5 ml-3">
                      {hoveredTeamId === t.id && (
                        <>
                          <button
                            className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20"
                            onClick={(e) => { e.stopPropagation(); void handleCloneTeam(t.id, false) }}
                            title="Restart with same task + agents (fresh)"
                          >
                            <RotateCcw className="size-3" />
                            Restart
                          </button>
                          <button
                            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                            onClick={(e) => { e.stopPropagation(); void handleCloneTeam(t.id, true) }}
                            title="Continue with message context from previous session"
                          >
                            <FastForward className="size-3" />
                            Continue
                          </button>
                          <button
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (confirm(`Delete team "${t.name}" and all its data?`)) {
                                fetch(`/api/ensemble/teams/${t.id}/purge`, { method: 'DELETE' })
                                  .then(() => void fetchTeams())
                                  .catch(() => {})
                              }
                            }}
                            title="Permanently delete this team"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </>
                      )}
                      <ChevronRight
                        className={cn(
                          'size-4 text-muted-foreground/50 transition-transform',
                          hoveredTeamId === t.id && 'translate-x-0.5 text-muted-foreground',
                        )}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* ── Quick Reference sidebar (right) ─────────────── */}
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-l border-border p-4 lg:block">
          <h3 className="mb-3 flex items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
            <Activity className="size-3" />
            Quick Reference
          </h3>

          <div className="flex flex-col gap-3">
            <RefItem label="Create team (CLI)" cmd='ensemble run "task" --agents codex,claude' />
            <RefItem label="Create team (API)" cmd={'curl -X POST localhost:23000/api/ensemble/teams \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"my-team","agents":[{"program":"codex"},{"program":"claude"}]}\''} />
            <RefItem label="Monitor (CLI)" cmd="ensemble monitor --latest" />
            <RefItem label="Monitor (web)" cmd="http://localhost:5173" />
            <RefItem label="List teams" cmd="ensemble teams" />
            <RefItem label="Steer a team" cmd='ensemble steer <team-id> "message"' />
            <RefItem label="Add agent mid-collab" cmd={'curl -X POST localhost:23000/api/ensemble/teams/<id>/agents \\\n  -d \'{"program":"claude"}\''} />
            <RefItem label="Server status" cmd="ensemble status" />
          </div>

          <div className="mt-4 border-t border-border pt-3">
            <h4 className="mb-2 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground">Environment</h4>
            <div className="flex flex-col gap-1 font-mono text-[0.6rem] text-muted-foreground/70">
              <span>ENSEMBLE_PORT=23000</span>
              <span>ENSEMBLE_HOST=127.0.0.1</span>
              <span>ENSEMBLE_DATA_DIR=~/.ensemble</span>
            </div>
          </div>
        </aside>
        </div>
      )}
    </div>
  )
}

function RefItem({ label, cmd }: { label: string; cmd: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[0.6rem] font-medium text-muted-foreground">{label}</span>
      <div className="group relative">
        <pre className="overflow-x-auto rounded bg-background px-2 py-1.5 font-mono text-[0.6rem] leading-relaxed text-foreground/70 whitespace-pre-wrap break-all">
          {cmd}
        </pre>
        <button
          className="absolute top-1 right-1 rounded p-0.5 text-muted-foreground/30 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
          onClick={() => {
            navigator.clipboard.writeText(cmd).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }).catch(() => {})
          }}
          title="Copy"
        >
          {copied ? <span className="text-green-400 text-[0.6rem]">✓</span> : <span className="text-[0.6rem]">⧉</span>}
        </button>
      </div>
    </div>
  )
}
