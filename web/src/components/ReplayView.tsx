/**
 * ReplayView — shareable replay of a team's conversation.
 * Loads full message history via /api/agent-forge/teams/:id/replay.
 * Supports playback with timing, play/pause, speed control, progress bar.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Play, Pause, SkipBack, Share2, ArrowLeft, Loader2, CheckCircle2,
} from 'lucide-react'
import { cn } from '../lib/utils'
import type { AgentForgeTeam, AgentForgeMessage } from '../types'
import { MessageFeed } from './MessageFeed'
import { AgentBadge } from './AgentBadge'

interface ReplayViewProps {
  teamId: string
  onBack?: () => void
}

const SPEEDS = [1, 2, 5] as const
type Speed = typeof SPEEDS[number]

export function ReplayView({ teamId, onBack }: ReplayViewProps) {
  const [team, setTeam] = useState<AgentForgeTeam | null>(null)
  const [allMessages, setAllMessages] = useState<AgentForgeMessage[]>([])
  const [visibleMessages, setVisibleMessages] = useState<AgentForgeMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Playback state
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(1)
  const [playIndex, setPlayIndex] = useState(0)
  const [copied, setCopied] = useState(false)

  const playIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const playIndexRef = useRef(0)

  // Load replay data
  useEffect(() => {
    setLoading(true)
    fetch(`/api/agent-forge/teams/${teamId}/replay`)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error)
        setTeam(data.team)
        setAllMessages(data.messages ?? [])
        // Show all messages immediately on load (not auto-playing)
        setVisibleMessages(data.messages ?? [])
        setPlayIndex((data.messages ?? []).length)
        playIndexRef.current = (data.messages ?? []).length
        setLoading(false)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load replay')
        setLoading(false)
      })
  }, [teamId])

  const stopPlayback = useCallback(() => {
    setPlaying(false)
    if (playIntervalRef.current) {
      clearTimeout(playIntervalRef.current)
      playIntervalRef.current = null
    }
  }, [])

  const startPlayback = useCallback((fromIndex: number) => {
    if (allMessages.length === 0) return
    setPlaying(true)
    playIndexRef.current = fromIndex

    const scheduleNext = (idx: number) => {
      if (idx >= allMessages.length) {
        setPlaying(false)
        return
      }

      const currentMsg = allMessages[idx]
      const nextMsg = allMessages[idx + 1]

      setVisibleMessages(allMessages.slice(0, idx + 1))
      setPlayIndex(idx + 1)
      playIndexRef.current = idx + 1

      if (!nextMsg) {
        setPlaying(false)
        return
      }

      const timeDiff = new Date(nextMsg.timestamp).getTime() - new Date(currentMsg.timestamp).getTime()
      // Cap to 5s max gap, scale by speed
      const delay = Math.min(timeDiff, 5000) / speed

      playIntervalRef.current = setTimeout(() => scheduleNext(idx + 1), Math.max(50, delay))
    }

    scheduleNext(fromIndex)
  }, [allMessages, speed])

  const handlePlay = useCallback(() => {
    const from = playIndex >= allMessages.length ? 0 : playIndex
    if (from === 0) {
      setVisibleMessages([])
      setPlayIndex(0)
      playIndexRef.current = 0
    }
    startPlayback(from === 0 ? 0 : from)
  }, [playIndex, allMessages.length, startPlayback])

  const handlePause = useCallback(() => {
    stopPlayback()
  }, [stopPlayback])

  const handleRestart = useCallback(() => {
    stopPlayback()
    setVisibleMessages([])
    setPlayIndex(0)
    playIndexRef.current = 0
    setTimeout(() => startPlayback(0), 50)
  }, [stopPlayback, startPlayback])

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (allMessages.length === 0) return
    stopPlayback()
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    const idx = Math.round(ratio * allMessages.length)
    const clampedIdx = Math.max(0, Math.min(idx, allMessages.length))
    setPlayIndex(clampedIdx)
    playIndexRef.current = clampedIdx
    setVisibleMessages(allMessages.slice(0, clampedIdx))
  }, [allMessages, stopPlayback])

  const handleShare = useCallback(() => {
    const url = `${window.location.origin}/replay/${teamId}`
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }, [teamId])

  // Cleanup on unmount
  useEffect(() => () => {
    if (playIntervalRef.current) clearTimeout(playIntervalRef.current)
  }, [])

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
        <span className="text-sm">Loading replay…</span>
      </div>
    )
  }

  if (error || !team) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
        <div className="text-4xl">📼</div>
        <p className="text-sm text-destructive">{error ?? 'Team not found'}</p>
        {onBack && (
          <button onClick={onBack} className="text-xs hover:text-foreground">← Go back</button>
        )}
      </div>
    )
  }

  const progress = allMessages.length > 0 ? playIndex / allMessages.length : 0

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border px-4 py-3 shrink-0">
        {onBack && (
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
          </button>
        )}

        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm opacity-40">📼</span>
          <h1 className="font-semibold text-sm truncate">{team.name}</h1>
          <span className="text-[0.65rem] text-muted-foreground capitalize bg-muted px-1.5 py-0.5 rounded-full">
            {team.status}
          </span>
        </div>

        {/* Agent badges */}
        <div className="hidden sm:flex items-center gap-2">
          {team.agents.map(a => (
            <AgentBadge key={a.agentId} name={a.name} program={a.program} role={a.role} />
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleShare}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-[var(--border-strong)] transition-colors"
            title="Copy replay link"
          >
            {copied ? <CheckCircle2 className="size-3.5 text-green-400" /> : <Share2 className="size-3.5" />}
            {copied ? 'Copied!' : 'Share'}
          </button>
        </div>
      </header>

      {/* Playback controls */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2 shrink-0 bg-card/40">
        {/* Play/pause */}
        {playing ? (
          <button
            onClick={handlePause}
            className="inline-flex items-center justify-center size-7 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
            title="Pause"
          >
            <Pause className="size-3.5" />
          </button>
        ) : (
          <button
            onClick={handlePlay}
            className="inline-flex items-center justify-center size-7 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
            title={playIndex >= allMessages.length ? 'Replay from start' : 'Play'}
          >
            <Play className="size-3.5" />
          </button>
        )}

        {/* Restart */}
        <button
          onClick={handleRestart}
          className="inline-flex items-center justify-center size-7 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-[var(--border-strong)] transition-colors"
          title="Restart"
        >
          <SkipBack className="size-3.5" />
        </button>

        {/* Progress bar */}
        <div
          className="flex-1 h-2 bg-muted rounded-full cursor-pointer relative overflow-hidden"
          onClick={handleProgressClick}
          title="Click to seek"
        >
          <div
            className="h-full bg-primary rounded-full transition-all duration-100"
            style={{ width: `${progress * 100}%` }}
          />
        </div>

        {/* Message counter */}
        <span className="text-[0.65rem] font-mono tabular-nums text-muted-foreground shrink-0">
          {playIndex}/{allMessages.length}
        </span>

        {/* Speed toggle */}
        <div className="flex items-center gap-0.5">
          {SPEEDS.map(s => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={cn(
                'rounded px-2 py-0.5 text-[0.65rem] font-medium transition-colors',
                speed === s
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      {/* Message feed */}
      <div className="flex flex-1 overflow-hidden">
        <MessageFeed
          messages={visibleMessages}
          agents={team.agents}
          participants={[]}
          readOnly
        />
      </div>
    </div>
  )
}
