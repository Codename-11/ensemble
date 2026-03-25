import { useState, useEffect, useCallback } from 'react'
import {
  Plus,
  Loader2,
  Activity,
  ChevronRight,
  MessageCircle,
  Clock,
  Eye,
  Trash2,
  RotateCcw,
  Share2,
} from 'lucide-react'
import { cn } from '../lib/utils'
import type { AgentForgeTeam, AgentForgeTeamAgent } from '../types'
import { navigate } from '../hooks/useRouter'
import { LaunchForm } from './LaunchForm'

interface TeamListViewProps {
  onServerStatus?: (online: boolean, connecting: boolean) => void
}

function timeAgo(isoString: string): string {
  const now = Date.now()
  const then = new Date(isoString).getTime()
  const seconds = Math.floor((now - then) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function agentColor(agent: AgentForgeTeamAgent): string {
  const prog = agent.program.toLowerCase()
  if (prog.includes('codex')) return 'var(--agent-codex)'
  if (prog.includes('claude')) return 'var(--agent-claude)'
  if (prog.includes('gemini')) return 'var(--agent-gemini)'
  if (prog.includes('aider')) return 'var(--agent-aider)'
  return 'var(--agent-default)'
}

export function TeamListView({ onServerStatus }: TeamListViewProps) {
  const [teams, setTeams] = useState<AgentForgeTeam[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showLaunchForm, setShowLaunchForm] = useState(false)
  const [hoveredTeamId, setHoveredTeamId] = useState<string | null>(null)

  // Listen for "new team" event from sidebar
  useEffect(() => {
    const handler = () => setShowLaunchForm(true)
    window.addEventListener('agent-forge:new-team', handler)
    return () => window.removeEventListener('agent-forge:new-team', handler)
  }, [])

  const fetchTeams = useCallback(async () => {
    try {
      const res = await fetch('/api/agent-forge/teams')
      if (!res.ok) {
        setError(`Failed to load teams: ${res.status}`)
        onServerStatus?.(false, false)
        return
      }
      const data = await res.json()
      setTeams(data.teams ?? data)
      setError(null)
      onServerStatus?.(true, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load teams')
      onServerStatus?.(false, false)
    } finally {
      setLoading(false)
    }
  }, [onServerStatus])

  useEffect(() => {
    onServerStatus?.(false, true)
    void fetchTeams()
    const interval = setInterval(() => void fetchTeams(), 10000)
    return () => clearInterval(interval)
  }, [fetchTeams, onServerStatus])

  const handleDisband = async (teamId: string, teamName: string) => {
    if (!confirm(`Disband "${teamName}"?`)) return
    try {
      await fetch(`/api/agent-forge/teams/${teamId}/disband`, { method: 'POST' })
      void fetchTeams()
    } catch { /* ignore */ }
  }

  const handleClone = async (teamId: string) => {
    try {
      const res = await fetch(`/api/agent-forge/teams/${teamId}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seedMessages: false }),
      })
      if (!res.ok) return
      const data = await res.json()
      const newId: string = data.team?.id ?? data.id
      if (newId) navigate(`/app/team/${newId}`)
    } catch { /* ignore */ }
  }

  const handleShare = async (team: AgentForgeTeam) => {
    const shareUrl = `${window.location.origin}/team/${team.id}`
    try {
      await navigator.clipboard.writeText(shareUrl)
      alert(`Share link copied!\n${shareUrl}`)
    } catch {
      prompt('Share this link:', shareUrl)
    }
  }

  const activeTeams = teams
    .filter(t => t.status === 'active' || t.status === 'forming')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground h-full">
        <Loader2 className="size-6 animate-spin" />
        <span className="text-sm">Loading teams...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {showLaunchForm && (
        <LaunchForm
          onLaunch={(id) => { navigate(`/app/team/${id}`); setShowLaunchForm(false) }}
          onCancel={() => setShowLaunchForm(false)}
        />
      )}

      {error && (
        <div className="border-b border-destructive/20 bg-destructive/5 px-6 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="p-4 lg:p-6 flex flex-col gap-6">
        {/* Active teams header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="size-3.5 text-[var(--status-active)]" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Active Teams
            </h2>
            <span className="text-xs text-muted-foreground">({activeTeams.length})</span>
          </div>
          <button
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            onClick={() => setShowLaunchForm(true)}
          >
            <Plus className="size-3.5" />
            Deploy a Team
          </button>
        </div>

        {/* Team list */}
        {activeTeams.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-16 text-center">
            <span className="text-4xl opacity-20">🤝</span>
            <div>
              <p className="text-sm font-medium text-muted-foreground">No active teams</p>
              <p className="mt-1 text-xs text-muted-foreground/60">Create one to get started.</p>
            </div>
            <button
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              onClick={() => setShowLaunchForm(true)}
            >
              <Plus className="size-4" />
              Create a Team
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {activeTeams.map(t => (
              <li
                key={t.id}
                className={cn(
                  'group relative flex cursor-pointer items-center justify-between rounded-lg border border-border bg-card p-3 lg:p-4',
                  'transition-all hover:border-[var(--border-strong)] hover:bg-muted/30',
                  'border-l-2',
                  t.status === 'active' ? 'border-l-green-500' : 'border-l-yellow-500',
                )}
                onClick={() => navigate(`/app/team/${t.id}`)}
                onMouseEnter={() => setHoveredTeamId(t.id)}
                onMouseLeave={() => setHoveredTeamId(null)}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  {/* Name + status */}
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

                  {/* Description */}
                  {t.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2 max-w-lg">
                      {t.description}
                    </p>
                  )}

                  {/* Metadata */}
                  <div className="flex items-center gap-3 mt-0.5">
                    {/* Agent dots */}
                    <div className="flex items-center gap-1.5">
                      {t.agents.map(agent => (
                        <div
                          key={agent.name}
                          className="flex items-center gap-1"
                          title={`${agent.name} (${agent.program})`}
                        >
                          <span
                            className="inline-block size-2 rounded-full"
                            style={{ backgroundColor: agentColor(agent) }}
                          />
                          <span className="text-[10px] text-muted-foreground">{agent.name}</span>
                        </div>
                      ))}
                    </div>

                    <span className="text-muted-foreground/30">·</span>

                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Clock className="size-2.5" />
                      <span>{timeAgo(t.createdAt)}</span>
                    </div>

                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <MessageCircle className="size-2.5" />
                      <span>{t.agents.length} agents</span>
                    </div>
                  </div>
                </div>

                {/* Right: quick actions + arrow */}
                <div className="flex shrink-0 items-center gap-1.5 ml-3">
                  {hoveredTeamId === t.id && (
                    <>
                      <button
                        className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20"
                        onClick={(e) => { e.stopPropagation(); void handleShare(t) }}
                        title="Copy share link"
                      >
                        <Share2 className="size-3" />
                        Share
                      </button>
                      <button
                        className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                        onClick={(e) => { e.stopPropagation(); void handleClone(t.id) }}
                        title="Clone this team"
                      >
                        <RotateCcw className="size-3" />
                        Clone
                      </button>
                      <button
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); void handleDisband(t.id, t.name) }}
                        title="Disband team"
                      >
                        <Trash2 className="size-3" />
                      </button>
                      <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary">
                        <Eye className="size-3" />
                        View
                      </span>
                    </>
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
      </div>
    </div>
  )
}
