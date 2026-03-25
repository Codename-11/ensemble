import { useState, useEffect, useCallback } from 'react'
import { Settings, Save, Loader2, ChevronRight, Globe, Lock, Link, Copy, Check, Eye, Users } from 'lucide-react'
import { cn } from '../lib/utils'
import type { AgentForgeTeam, TeamConfig, TeamVisibility } from '../types'

interface TeamControlsProps {
  team: AgentForgeTeam
  messageCount: number
}

function msToMin(ms: number | undefined): string {
  if (!ms || ms <= 0) return ''
  return String(Math.round((ms / 60000) * 10) / 10)
}

function formatElapsed(startIso: string): string {
  const elapsed = Date.now() - new Date(startIso).getTime()
  const totalSec = Math.floor(elapsed / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function TeamControls({ team, messageCount }: TeamControlsProps) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const config = team.config || {}

  const [maxTurns, setMaxTurns] = useState(config.maxTurns?.toString() ?? '')
  const [timeoutMin, setTimeoutMin] = useState(msToMin(config.timeoutMs))
  const [nudgeMin, setNudgeMin] = useState(msToMin(config.nudgeAfterMs))
  const [stallMin, setStallMin] = useState(msToMin(config.stallAfterMs))

  // Sync local state when team config changes externally
  useEffect(() => {
    const c = team.config || {}
    setMaxTurns(c.maxTurns?.toString() ?? '')
    setTimeoutMin(msToMin(c.timeoutMs))
    setNudgeMin(msToMin(c.nudgeAfterMs))
    setStallMin(msToMin(c.stallAfterMs))
  }, [team.config])

  // Elapsed time ticker
  const [elapsed, setElapsed] = useState(formatElapsed(team.createdAt))
  useEffect(() => {
    if (team.status !== 'active' && team.status !== 'forming') return
    const interval = setInterval(() => setElapsed(formatElapsed(team.createdAt)), 1000)
    return () => clearInterval(interval)
  }, [team.createdAt, team.status])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    setSaved(false)

    const patch: Partial<TeamConfig> = {}
    const parsedMaxTurns = parseInt(maxTurns, 10)
    if (Number.isFinite(parsedMaxTurns) && parsedMaxTurns >= 0) patch.maxTurns = parsedMaxTurns
    const parsedTimeout = parseFloat(timeoutMin)
    if (Number.isFinite(parsedTimeout) && parsedTimeout >= 0) patch.timeoutMs = Math.round(parsedTimeout * 60000)
    const parsedNudge = parseFloat(nudgeMin)
    if (Number.isFinite(parsedNudge) && parsedNudge >= 0) patch.nudgeAfterMs = Math.round(parsedNudge * 60000)
    const parsedStall = parseFloat(stallMin)
    if (Number.isFinite(parsedStall) && parsedStall >= 0) patch.stallAfterMs = Math.round(parsedStall * 60000)

    try {
      const res = await fetch(`/api/agent-forge/teams/${team.id}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error || `Failed: ${res.status}`)
      }

      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config')
    } finally {
      setSaving(false)
    }
  }, [team.id, maxTurns, timeoutMin, nudgeMin, stallMin])

  const isActive = team.status === 'active' || team.status === 'forming'

  return (
    <div className="border-t border-border pt-3">
      {/* Visibility controls */}
      <VisibilityControls team={team} />

      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 text-[0.65rem] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <Settings className="size-3" />
        Team Controls
        <ChevronRight className={cn('ml-auto size-3 transition-transform', open && 'rotate-90')} />
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2.5">
          {/* Status indicators */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5">
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-muted-foreground">Messages</span>
              <span className="font-mono text-foreground">
                {messageCount}
                {config.maxTurns ? ` / ${config.maxTurns}` : ''}
              </span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-muted-foreground">Runtime</span>
              <span className="font-mono text-foreground">
                {elapsed}
                {config.timeoutMs ? ` / ${Math.round(config.timeoutMs / 60000)}min` : ''}
              </span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-muted-foreground">Nudge threshold</span>
              <span className="font-mono text-foreground">
                {config.nudgeAfterMs ? `${Math.round(config.nudgeAfterMs / 60000)}min` : '3min (default)'}
              </span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-muted-foreground">Stall threshold</span>
              <span className="font-mono text-foreground">
                {config.stallAfterMs ? `${Math.round(config.stallAfterMs / 60000)}min` : '5min (default)'}
              </span>
            </div>
          </div>

          {/* Editable fields (only for active teams) */}
          {isActive && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-0.5 text-[0.6rem] font-medium text-muted-foreground">
                  Max turns
                  <input
                    type="number"
                    min="0"
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                    placeholder="100"
                    value={maxTurns}
                    onChange={e => setMaxTurns(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-[0.6rem] font-medium text-muted-foreground">
                  Timeout (min)
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                    placeholder="10"
                    value={timeoutMin}
                    onChange={e => setTimeoutMin(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-[0.6rem] font-medium text-muted-foreground">
                  Nudge (min)
                  <input
                    type="number"
                    min="0.5"
                    step="0.5"
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                    placeholder="3"
                    value={nudgeMin}
                    onChange={e => setNudgeMin(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-[0.6rem] font-medium text-muted-foreground">
                  Stall (min)
                  <input
                    type="number"
                    min="1"
                    step="0.5"
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                    placeholder="5"
                    value={stallMin}
                    onChange={e => setStallMin(e.target.value)}
                  />
                </label>
              </div>

              {error && (
                <p className="text-[0.65rem] text-destructive">{error}</p>
              )}

              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className={cn(
                  'inline-flex items-center justify-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  saved
                    ? 'bg-green-500/10 text-green-500 border border-green-500/20'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90',
                  'disabled:opacity-50',
                )}
              >
                {saving ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Save className="size-3" />
                )}
                {saved ? 'Saved' : saving ? 'Saving...' : 'Save Config'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Visibility Controls ──────────────────────────────────────────

function VisibilityControls({ team }: { team: AgentForgeTeam }) {
  const [changing, setChanging] = useState(false)
  const [copied, setCopied] = useState(false)
  const [shareUrl, setShareUrl] = useState<string | null>(team.shareLink?.url ?? null)
  const [open, setOpen] = useState(false)

  const visibility = team.visibility ?? 'private'

  const handleVisibilityChange = useCallback(async (v: TeamVisibility) => {
    if (v === visibility) return
    setChanging(true)
    try {
      const res = await fetch(`/api/agent-forge/teams/${team.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: v }),
      })
      if (res.ok) {
        const data = await res.json() as { team?: AgentForgeTeam; shareLink?: { url: string } }
        if (data.shareLink?.url) setShareUrl(data.shareLink.url)
        else if (v === 'private') setShareUrl(null)
      }
    } catch { /* ignore */ } finally {
      setChanging(false)
    }
  }, [team.id, visibility])

  const handleCopyLink = useCallback(() => {
    if (!shareUrl) return
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }, [shareUrl])

  const visLabel = visibility === 'public' ? 'Public' : visibility === 'shared' ? 'Shared' : 'Private'
  const VisIcon = visibility === 'public' ? Globe : visibility === 'shared' ? Link : Lock

  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 text-[0.65rem] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <VisIcon className="size-3" />
        Visibility
        <span className={cn(
          'ml-1 rounded-full px-1.5 py-0.5 text-[0.6rem] font-medium',
          visibility === 'public' ? 'bg-green-500/15 text-green-400' :
          visibility === 'shared' ? 'bg-blue-500/15 text-blue-400' :
          'bg-muted text-muted-foreground',
        )}>
          {visLabel}
        </span>
        <ChevronRight className={cn('ml-auto size-3 transition-transform', open && 'rotate-90')} />
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {/* Toggle buttons */}
          <div className="flex gap-1.5">
            {(['private', 'shared', 'public'] as TeamVisibility[]).map(v => (
              <button
                key={v}
                disabled={changing}
                onClick={() => void handleVisibilityChange(v)}
                className={cn(
                  'flex-1 rounded-md px-2 py-1.5 text-[0.65rem] font-medium transition-colors capitalize',
                  v === visibility
                    ? v === 'public' ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                      : v === 'shared' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                      : 'bg-muted text-foreground border border-border'
                    : 'text-muted-foreground hover:bg-muted border border-transparent',
                )}
              >
                {v === 'private' && <Lock className="inline size-2.5 mr-1 mb-0.5" />}
                {v === 'shared' && <Link className="inline size-2.5 mr-1 mb-0.5" />}
                {v === 'public' && <Globe className="inline size-2.5 mr-1 mb-0.5" />}
                {v}
              </button>
            ))}
          </div>

          {/* Descriptions */}
          <p className="text-[0.6rem] text-muted-foreground/60">
            {visibility === 'private' && 'Only local agents can access this team.'}
            {visibility === 'shared' && 'Anyone with the link can spectate or join.'}
            {visibility === 'public' && 'Listed in lobby. Anyone can spectate or join.'}
          </p>

          {/* Share link */}
          {(visibility === 'shared' || visibility === 'public') && (
            <div className="flex flex-col gap-1.5">
              {shareUrl ? (
                <div className="flex items-center gap-1.5">
                  <input
                    readOnly
                    value={shareUrl}
                    className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-[0.6rem] font-mono text-muted-foreground/80 focus:outline-none"
                  />
                  <button
                    onClick={handleCopyLink}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[0.6rem] text-muted-foreground hover:bg-muted"
                    title="Copy link"
                  >
                    {copied ? <Check className="size-3 text-green-400" /> : <Copy className="size-3" />}
                  </button>
                </div>
              ) : (
                <button
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/agent-forge/teams/${team.id}/share`, { method: 'POST' })
                      if (res.ok) {
                        const data = await res.json() as { shareLink?: { url: string } }
                        if (data.shareLink?.url) setShareUrl(data.shareLink.url)
                      }
                    } catch { /* ignore */ }
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1.5 text-[0.65rem] font-medium text-primary hover:bg-primary/20"
                >
                  <Link className="size-3" />
                  Generate share link
                </button>
              )}
            </div>
          )}

          {/* Participant count */}
          {(team.participants ?? []).filter(p => !p.leftAt).length > 0 && (
            <div className="flex items-center gap-1.5 text-[0.6rem] text-muted-foreground">
              <Users className="size-3" />
              <span>{(team.participants ?? []).filter(p => !p.leftAt).length} remote participant(s)</span>
            </div>
          )}

          {/* Spectate link */}
          {(visibility === 'shared' || visibility === 'public') && shareUrl && (
            <a
              href={shareUrl.replace('/team/', '/team/')}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[0.6rem] text-muted-foreground hover:text-foreground"
            >
              <Eye className="size-2.5" />
              Open spectator view
            </a>
          )}
        </div>
      )}
    </div>
  )
}
