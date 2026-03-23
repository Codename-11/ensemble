import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Users,
  UserPlus,
  Wifi,
  WifiOff,
  Clock,
  XCircle,
  PanelLeftClose,
  PanelLeft,
  FileText,
  TerminalSquare,
  ChevronRight,
  Loader2,
  HelpCircle,
  Copy,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { useUIStore } from '../stores/ui-store'
import type { EnsembleTeam, EnsembleMessage, EnsembleServerInfo } from '../types'
import { AgentBadge } from './AgentBadge'
import { ControlPanel } from './ControlPanel'
import { MessageFeed } from './MessageFeed'
import { TeamSummary } from './TeamSummary'
import { TerminalPanel } from './TerminalPanel'

interface MonitorProps {
  team: EnsembleTeam
  messages: EnsembleMessage[]
  connected: boolean
  error: string | null
  onSend: (content: string, to?: string) => Promise<void>
  onDisband: () => Promise<void>
  onBack: () => void
}

const STATUS_LABELS: Record<string, string> = {
  forming: 'Forming',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  disbanded: 'Disbanded',
  failed: 'Failed',
}

const AGENT_STATUS_LABELS: Record<string, string> = {
  spawning: 'Spawning',
  active: 'Active',
  idle: 'Idle',
  done: 'Done',
  failed: 'Failed',
}

function formatDuration(startIso: string, endIso?: string): string {
  const start = new Date(startIso).getTime()
  const end = endIso ? new Date(endIso).getTime() : Date.now()
  const totalSec = Math.floor((end - start) / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** Find the most recent message from a given agent */
function getLastMessagePreview(agentName: string, messages: EnsembleMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.from === agentName && m.content.trim()) {
      const text = m.content.trim().replace(/\s+/g, ' ')
      return text.length > 60 ? text.slice(0, 57) + '...' : text
    }
  }
  return undefined
}

const FALLBACK_AGENT_PROGRAMS = ['codex', 'claude', 'gemini', 'aider', 'opencode']

export function Monitor({ team, messages, connected, error, onSend, onDisband, onBack }: MonitorProps) {
  const isTerminal = team.status === 'completed' || team.status === 'disbanded' || team.status === 'failed'
  const isActive = team.status === 'active' || team.status === 'forming'
  const [viewMode, setViewMode] = useState<'summary' | 'messages'>(isTerminal ? 'summary' : 'messages')
  const duration = useMemo(() => formatDuration(team.createdAt, team.completedAt), [team.createdAt, team.completedAt])

  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)

  const [selectedSession, setSelectedSession] = useState<string | null>(null)

  // Add agent form state
  const [showAddAgent, setShowAddAgent] = useState(false)
  const [addAgentProgram, setAddAgentProgram] = useState('')
  const [addAgentSubmitting, setAddAgentSubmitting] = useState(false)
  const [addAgentError, setAddAgentError] = useState<string | null>(null)
  const [availablePrograms, setAvailablePrograms] = useState<string[]>(FALLBACK_AGENT_PROGRAMS)

  // Fetch available agent programs from server info
  useEffect(() => {
    fetch('/api/ensemble/info')
      .then(r => r.json())
      .then((data: EnsembleServerInfo) => {
        if (data.agents?.length) {
          setAvailablePrograms(data.agents.map(a => a.id))
        }
      })
      .catch(() => { /* use fallbacks */ })
  }, [])

  const handleAddAgent = useCallback(async () => {
    if (!addAgentProgram.trim()) return
    setAddAgentSubmitting(true)
    setAddAgentError(null)
    try {
      const res = await fetch(`/api/ensemble/teams/${team.id}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ program: addAgentProgram }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error || `Failed: ${res.status}`)
      }
      // Success — reset form
      setShowAddAgent(false)
      setAddAgentProgram('')
    } catch (err) {
      setAddAgentError(err instanceof Error ? err.message : 'Failed to add agent')
    } finally {
      setAddAgentSubmitting(false)
    }
  }, [team.id, addAgentProgram])
  const selectedAgent = selectedSession
    ? team.agents.find(a => `${team.name}-${a.name}` === selectedSession)
    : null

  // Pre-compute last message previews for agents
  const agentPreviews = useMemo(() => {
    const map: Record<string, string | undefined> = {}
    for (const agent of team.agents) {
      map[agent.agentId] = getLastMessagePreview(agent.name, messages)
    }
    return map
  }, [team.agents, messages])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Header ──────────────────────────────────────────────── */}
      <header className="flex shrink-0 flex-col border-b border-border">
        {/* Primary row: back, title, meta, actions */}
        <div className="flex items-center gap-3 px-4 py-2.5 lg:px-6">
          {/* Back button */}
          <button
            className="inline-flex items-center justify-center rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:border-[var(--border-strong)] hover:text-foreground"
            onClick={onBack}
            title="Back to team list"
          >
            <ArrowLeft className="size-4" />
          </button>

          {/* Title */}
          <h1 className="min-w-0 truncate text-lg font-bold tracking-tight">{team.name}</h1>

          {/* Compact meta badges in a single row */}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <span
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs font-medium',
                `status-${team.status}`,
              )}
            >
              {STATUS_LABELS[team.status] ?? team.status}
            </span>

            <span className="hidden items-center gap-1 font-mono text-xs text-muted-foreground sm:flex">
              <Clock className="size-3" />
              {duration}
            </span>

            <ConnectionStatus connected={connected} error={error} teamStatus={team.status} />

            {/* Sidebar toggle */}
            <button
              onClick={toggleSidebar}
              className="inline-flex items-center justify-center rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:border-[var(--border-strong)] hover:text-foreground lg:hidden"
              title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              {sidebarCollapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
            </button>

            {/* Disband button */}
            {!isTerminal && (
              <button
                className="inline-flex items-center gap-1.5 rounded-md border border-destructive/20 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                onClick={() => void onDisband()}
              >
                <XCircle className="size-3.5" />
                Disband
              </button>
            )}
          </div>
        </div>

        {/* Subtitle row: description */}
        {team.description && (
          <div className="border-t border-border/50 px-4 py-1.5 lg:px-6">
            <p className="truncate text-xs text-muted-foreground/70">{team.description}</p>
          </div>
        )}
      </header>

      {/* ── View mode tabs ──────────────────────────────────────── */}
      <div className="flex shrink-0 border-b border-border px-4 lg:px-6">
        <button
          onClick={() => setViewMode('summary')}
          className={cn(
            'relative px-4 py-2 text-xs font-medium transition-colors',
            viewMode === 'summary'
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground/80',
          )}
        >
          Summary
          {viewMode === 'summary' && (
            <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary" />
          )}
        </button>
        <button
          onClick={() => setViewMode('messages')}
          className={cn(
            'relative px-4 py-2 text-xs font-medium transition-colors',
            viewMode === 'messages'
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground/80',
          )}
        >
          Messages
          {viewMode === 'messages' && (
            <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary" />
          )}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive lg:px-6">
          {error}
        </div>
      )}

      {/* ── Body: sidebar + feed ────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Agent sidebar */}
        <aside
          className={cn(
            'flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border p-4 transition-all',
            sidebarCollapsed && 'hidden',
            'max-lg:hidden',
          )}
        >
          <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Users className="size-3.5" />
            Agents
            <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[0.6rem] font-medium tabular-nums text-muted-foreground">
              {team.agents.length}
            </span>
          </h2>

          <ul className="flex flex-col gap-2">
            {team.agents.map(agent => {
              const sessionKey = `${team.name}-${agent.name}`
              const isSelected = selectedSession === sessionKey
              const preview = agentPreviews[agent.agentId]
              const isActive = agent.status === 'active'

              return (
                <li
                  key={agent.name}
                  className={cn(
                    'flex flex-col gap-1 rounded-lg border p-2.5 cursor-pointer transition-all',
                    isSelected
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border bg-card hover:border-[var(--border-strong)] hover:bg-muted/30',
                  )}
                  onClick={() => setSelectedSession(isSelected ? null : sessionKey)}
                  title="Click to view terminal"
                >
                  {/* Row 1: badge + status */}
                  <div className="flex items-center justify-between gap-1">
                    <AgentBadge name={agent.name} program={agent.program} size="md" />
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span
                        className={cn(
                          'flex items-center gap-1 text-[0.65rem] font-medium',
                          `status-${agent.status}`,
                          'bg-transparent',
                        )}
                      >
                        {isActive && (
                          <span className="inline-block size-1.5 animate-[pulse-dot_1.4s_ease-in-out_infinite] rounded-full bg-current" />
                        )}
                        {AGENT_STATUS_LABELS[agent.status] ?? agent.status}
                      </span>
                    </div>
                  </div>

                  {/* Row 2: program label */}
                  <span className="pl-4 text-[0.65rem] text-muted-foreground/50">
                    {agent.program}
                  </span>

                  {/* Row 3: last message preview */}
                  {preview && (
                    <p className="mt-0.5 truncate pl-4 text-[0.65rem] leading-snug text-muted-foreground/70">
                      {preview}
                    </p>
                  )}

                  {/* Row 4: terminal click indicator */}
                  <div className="mt-0.5 flex items-center gap-1 pl-4">
                    <TerminalSquare
                      className={cn(
                        'size-3 transition-colors',
                        isSelected ? 'text-primary' : 'text-muted-foreground/30',
                      )}
                    />
                    <span className="text-[0.6rem] text-muted-foreground/40">
                      {isSelected ? 'Viewing terminal' : 'Open terminal'}
                    </span>
                    <ChevronRight className={cn(
                      'ml-auto size-3 transition-all',
                      isSelected ? 'text-primary rotate-90' : 'text-muted-foreground/20',
                    )} />
                  </div>
                </li>
              )
            })}
          </ul>

          {/* Add agent button + inline form */}
          {isActive && (
            <div className="flex flex-col gap-2">
              {!showAddAgent ? (
                <button
                  onClick={() => setShowAddAgent(true)}
                  className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  <UserPlus className="size-3.5" />
                  Add Agent
                </button>
              ) : (
                <div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2.5">
                  <label className="text-[0.65rem] font-medium uppercase tracking-wider text-muted-foreground">
                    Agent program
                  </label>
                  <select
                    value={addAgentProgram}
                    onChange={e => { setAddAgentProgram(e.target.value); setAddAgentError(null) }}
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  >
                    <option value="">Select...</option>
                    {availablePrograms.map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  {addAgentError && (
                    <p className="text-[0.65rem] text-destructive">{addAgentError}</p>
                  )}
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => void handleAddAgent()}
                      disabled={!addAgentProgram || addAgentSubmitting}
                      className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                    >
                      {addAgentSubmitting ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <UserPlus className="size-3" />
                      )}
                      Join
                    </button>
                    <button
                      onClick={() => { setShowAddAgent(false); setAddAgentProgram(''); setAddAgentError(null) }}
                      className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Result summary */}
          {team.result && (
            <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <FileText className="size-3.5" />
                Result
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {team.result.summary}
              </p>
              {team.result.filesChanged.length > 0 && (
                <div className="mt-1">
                  <h4 className="mb-1 text-[0.7rem] text-muted-foreground">Files changed</h4>
                  <ul className="flex flex-col gap-0.5 font-mono text-[0.7rem] text-muted-foreground">
                    {team.result.filesChanged.map((f, i) => (
                      <li key={i} className="truncate">{f}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {/* Quick Reference */}
          <QuickReference teamId={team.id} />
        </aside>

        {/* Main content area: summary or message feed + terminal */}
        <main className={cn(
          'flex min-w-0 flex-1 overflow-hidden',
          viewMode === 'messages' && selectedSession ? 'flex-row' : 'flex-col',
        )}>
          {viewMode === 'summary' ? (
            <TeamSummary team={team} messages={messages} />
          ) : (
            <>
              <div className={cn(
                'flex flex-col overflow-hidden',
                selectedSession ? 'w-3/5 min-w-0 border-r border-border' : 'flex-1',
              )}>
                <MessageFeed messages={messages} agents={team.agents} />
                <ControlPanel agents={team.agents} onSend={onSend} disabled={isTerminal} />
              </div>
              {selectedSession && selectedAgent && (
                <div className="w-2/5 min-w-0">
                  <TerminalPanel
                    sessionName={selectedSession}
                    agentName={selectedAgent.name}
                    onClose={() => setSelectedSession(null)}
                  />
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

// ── Quick Reference panel ───────────────────────────────────────────

// ── Connection status badge ──────────────────────────────────────────

function ConnectionStatus({ connected, error, teamStatus }: {
  connected: boolean
  error: string | null
  teamStatus: string
}) {
  const isTerminal = teamStatus === 'completed' || teamStatus === 'disbanded' || teamStatus === 'failed'

  // Determine display state
  let icon: React.ReactNode
  let label: string
  let colorClass: string

  if (isTerminal) {
    // Team is done — no need to show connection status
    return null
  } else if (error) {
    icon = <WifiOff className="size-3" />
    label = 'Reconnecting'
    colorClass = 'text-yellow-500'
  } else if (connected) {
    icon = <span className="relative flex size-2">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-400 opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-green-500" />
    </span>
    label = 'Live'
    colorClass = 'text-green-500'
  } else {
    icon = <Loader2 className="size-3 animate-spin" />
    label = 'Connecting'
    colorClass = 'text-muted-foreground'
  }

  return (
    <span className={cn('hidden items-center gap-1.5 text-xs sm:flex', colorClass)}>
      {icon}
      {label}
    </span>
  )
}

function QuickReference({ teamId }: { teamId: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const commands = [
    { label: 'New team', cmd: 'ensemble run "task" --agents codex,claude' },
    { label: 'Add agent', cmd: `curl -X POST http://localhost:23000/api/ensemble/teams/${teamId}/agents -H "Content-Type: application/json" -d '{"program":"claude"}'` },
    { label: 'Steer team', cmd: `ensemble steer ${teamId.slice(0, 8)} "your message"` },
    { label: 'Monitor (CLI)', cmd: `ensemble monitor ${teamId.slice(0, 8)}` },
    { label: 'Monitor (web)', cmd: `http://localhost:5173/#${teamId}` },
    { label: 'Disband', cmd: `curl -X POST http://localhost:23000/api/ensemble/teams/${teamId}/disband` },
  ]

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    }).catch(() => {})
  }

  return (
    <div className="mt-auto border-t border-border pt-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 text-[0.65rem] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <HelpCircle className="size-3" />
        Quick Reference
        <ChevronRight className={cn('ml-auto size-3 transition-transform', open && 'rotate-90')} />
      </button>

      {open && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {commands.map(({ label, cmd }) => (
            <li key={label} className="group flex flex-col gap-0.5">
              <span className="text-[0.6rem] font-medium text-muted-foreground">{label}</span>
              <div className="flex items-start gap-1">
                <code className="flex-1 break-all rounded bg-background px-1.5 py-1 font-mono text-[0.6rem] leading-relaxed text-foreground/70">
                  {cmd}
                </code>
                <button
                  onClick={() => copyToClipboard(cmd, label)}
                  className="shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:text-foreground"
                  title="Copy"
                >
                  <Copy className={cn('size-2.5', copied === label && 'text-green-400')} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
