import { useState, useEffect, useCallback } from 'react'
import { Loader2, Clock, Users, Search, Trash2, RotateCcw } from 'lucide-react'
import { cn } from '../lib/utils'
import type { AgentForgeTeam } from '../types'
import { navigate } from '../hooks/useRouter'

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function timeAgo(isoString: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function HistoryView() {
  const [teams, setTeams] = useState<AgentForgeTeam[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null)

  const fetchTeams = useCallback(async () => {
    try {
      const res = await fetch('/api/agent-forge/teams')
      if (!res.ok) { setError(`Failed: ${res.status}`); return }
      const data = await res.json()
      const all: AgentForgeTeam[] = data.teams ?? data
      const past = all
        .filter(t => t.status !== 'active' && t.status !== 'forming')
        .sort((a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime())
      setTeams(past)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchTeams()
  }, [fetchTeams])

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

  const handlePurge = async (teamId: string) => {
    try {
      await fetch(`/api/agent-forge/teams/${teamId}/purge`, { method: 'DELETE' })
      setTeams(prev => prev.filter(t => t.id !== teamId))
    } catch { /* ignore */ }
    setConfirmPurge(null)
  }

  const filtered = teams.filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase())
  )

  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground h-full">
        <Loader2 className="size-6 animate-spin" />
        <span className="text-sm">Loading history...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-4 lg:p-6 flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            📼 Team History
            {teams.length > 0 && (
              <span className="text-muted-foreground">({teams.length})</span>
            )}
          </h2>
          {teams.length > 0 && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="bg-muted border border-border rounded-md pl-7 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary w-40"
              />
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {error}
          </div>
        )}

        {teams.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-16 text-center">
            <span className="text-4xl opacity-20">📼</span>
            <div>
              <p className="text-sm font-medium text-muted-foreground">No past teams yet</p>
              <p className="mt-1 text-xs text-muted-foreground/60">Disbanded teams will appear here.</p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground">
            No teams match "{search}"
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.map(t => {
              const duration = t.completedAt
                ? formatDuration(new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime())
                : null

              return (
                <li
                  key={t.id}
                  className="group flex items-start justify-between rounded-lg border border-border/60 bg-card/50 p-3 lg:p-4 gap-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {/* Name + status */}
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-sm">{t.name}</span>
                      <span className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
                        `status-${t.status}`,
                      )}>
                        {t.status}
                      </span>
                    </div>

                    {/* Description */}
                    {t.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2 max-w-lg">{t.description}</p>
                    )}

                    {/* Metadata */}
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground mt-0.5">
                      {duration && (
                        <span className="flex items-center gap-1">
                          <Clock className="size-2.5" />
                          {duration}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Users className="size-2.5" />
                        {t.agents.length} agents
                      </span>
                      <span className="text-muted-foreground/30">·</span>
                      <span>{timeAgo(t.completedAt ?? t.createdAt)}</span>
                      {t.result?.disbandReason && (
                        <>
                          <span className="text-muted-foreground/30">·</span>
                          <span className="italic">{t.result.disbandReason}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    {t.status === 'disbanded' && (
                      <button
                        className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        onClick={() => navigate(`/replay/${t.id}`)}
                        title="Watch replay"
                      >
                        📼 Replay
                      </button>
                    )}
                    <button
                      className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20"
                      onClick={() => void handleClone(t.id)}
                      title="Clone this team"
                    >
                      <RotateCcw className="size-3" />
                      Clone
                    </button>
                    {confirmPurge === t.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          className="rounded-md bg-destructive/80 px-2.5 py-1.5 text-[10px] font-medium text-white transition-colors hover:bg-destructive"
                          onClick={() => void handlePurge(t.id)}
                        >
                          Confirm
                        </button>
                        <button
                          className="rounded-md bg-muted px-2 py-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                          onClick={() => setConfirmPurge(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-medium text-destructive/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setConfirmPurge(t.id)}
                        title="Permanently delete"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
