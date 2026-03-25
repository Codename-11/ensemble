/**
 * SpectatorView — read-only live view of a shared/public team.
 * Connects to /api/agent-forge/teams/:id/spectate SSE stream.
 * Allows upgrading to human participant via "Join as Human".
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, Radio, Users, Eye, ArrowLeft, UserPlus, Volume2, VolumeX } from 'lucide-react'
import { cn } from '../lib/utils'
import type { AgentForgeTeam, AgentForgeMessage, RemoteParticipant } from '../types'
import { MessageFeed } from './MessageFeed'
import { AgentBadge, AgentCard } from './AgentBadge'
import { SteerInput } from './SteerInput'
import { StatsOverlay } from './StatsOverlay'
import { useSounds, getMuted } from '../hooks/useSounds'

interface SpectatorViewProps {
  teamId: string
  token?: string
  onBack?: () => void
  onWatchReplay?: (teamId: string) => void
}

export function SpectatorView({ teamId, token, onBack, onWatchReplay }: SpectatorViewProps) {
  const [team, setTeam] = useState<AgentForgeTeam | null>(null)
  const [messages, setMessages] = useState<AgentForgeMessage[]>([])
  const [participants, setParticipants] = useState<RemoteParticipant[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [spectatorCount, setSpectatorCount] = useState(0)

  // Typing indicators: participantId → timeout handle
  const [typingAgents, setTypingAgents] = useState<Record<string, boolean>>({})
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Human join state
  const [showJoinForm, setShowJoinForm] = useState(false)
  const [joinName, setJoinName] = useState('')
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [joinedAsHuman, setJoinedAsHuman] = useState(false)

  // Sound state
  const sounds = useSounds()
  const [muted, setMuted] = useState(getMuted())

  const esRef = useRef<EventSource | null>(null)
  const prevMessageCount = useRef(0)

  const clearTyping = useCallback((participantId: string) => {
    if (typingTimers.current[participantId]) {
      clearTimeout(typingTimers.current[participantId])
      delete typingTimers.current[participantId]
    }
    setTypingAgents(prev => {
      const next = { ...prev }
      delete next[participantId]
      return next
    })
  }, [])

  const setTyping = useCallback((participantId: string) => {
    setTypingAgents(prev => ({ ...prev, [participantId]: true }))
    // Auto-clear after 5s
    if (typingTimers.current[participantId]) clearTimeout(typingTimers.current[participantId])
    typingTimers.current[participantId] = setTimeout(() => clearTyping(participantId), 5000)
  }, [clearTyping])

  // Connect SSE spectator stream
  useEffect(() => {
    const spectateUrl = token
      ? `/api/agent-forge/teams/${teamId}/spectate?token=${encodeURIComponent(token)}`
      : `/api/agent-forge/teams/${teamId}/spectate`

    const es = new EventSource(spectateUrl)
    esRef.current = es

    es.addEventListener('init', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          team: AgentForgeTeam
          messages: AgentForgeMessage[]
          participants: RemoteParticipant[]
        }
        setTeam(data.team)
        setMessages(data.messages ?? [])
        setParticipants(data.participants ?? [])
        prevMessageCount.current = (data.messages ?? []).length
        setConnected(true)
        setError(null)
      } catch { /* ignore */ }
    })

    es.addEventListener('message', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { messages: AgentForgeMessage[] }
        setMessages(prev => {
          const existing = new Set(prev.map(m => m.id))
          const news = data.messages.filter(m => !existing.has(m.id))
          if (news.length > 0) {
            sounds.playMessage()
            // Clear typing for senders
            for (const msg of news) {
              clearTyping(msg.from)
            }
          }
          return [...prev, ...news]
        })
      } catch { /* ignore */ }
    })

    es.addEventListener('typing', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { participant_id: string }
        setTyping(data.participant_id)
      } catch { /* ignore */ }
    })

    es.addEventListener('typing_stop', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { participant_id: string }
        clearTyping(data.participant_id)
      } catch { /* ignore */ }
    })

    es.addEventListener('stats', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          spectator_count: number
          message_count: number
          elapsed_ms: number
        }
        setSpectatorCount(data.spectator_count)
      } catch { /* ignore */ }
    })

    es.addEventListener('join', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { participant: RemoteParticipant }
        setParticipants(prev => [...prev.filter(p => p.participantId !== data.participant.participantId), data.participant])
        sounds.playJoin()
      } catch { /* ignore */ }
    })

    es.addEventListener('leave', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { participantId: string }
        setParticipants(prev => prev.map(p =>
          p.participantId === data.participantId ? { ...p, leftAt: new Date().toISOString() } : p
        ))
      } catch { /* ignore */ }
    })

    es.addEventListener('disbanded', () => {
      setConnected(false)
      sounds.playDisband()
      es.close()
    })

    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { error: string }
        setError(data.error)
      } catch { /* ignore */ }
    })

    es.onerror = () => {
      setConnected(false)
      setError('Connection lost — reconnecting…')
    }

    return () => {
      es.close()
      esRef.current = null
      // Clear all typing timers
      for (const t of Object.values(typingTimers.current)) clearTimeout(t)
    }
  }, [teamId, token]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleJoinAsHuman = useCallback(async () => {
    if (!joinName.trim()) return
    setJoining(true)
    setJoinError(null)
    try {
      const body: Record<string, unknown> = { agent_name: joinName.trim() }
      if (token) body.auth_token = token
      const res = await fetch(`/api/agent-forge/teams/${teamId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setJoinError(data.error ?? 'Failed to join')
        return
      }
      setSessionToken(data.session_token)
      setJoinedAsHuman(true)
      setShowJoinForm(false)
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Failed to join')
    } finally {
      setJoining(false)
    }
  }, [teamId, token, joinName])

  const handleSendMessage = useCallback(async (content: string) => {
    if (!sessionToken) return
    await fetch(`/api/agent-forge/teams/${teamId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ content, to: 'team' }),
    })
  }, [teamId, sessionToken])

  const handleToggleMute = useCallback(() => {
    const nowMuted = sounds.toggleMute()
    setMuted(nowMuted)
  }, [sounds])

  // Determine status color
  const statusColor = team?.status === 'active' ? 'text-green-400' :
    team?.status === 'forming' ? 'text-yellow-400' :
    team?.status === 'disbanded' ? 'text-red-400' : 'text-muted-foreground'

  if (error && !team) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
        <div className="text-4xl">🔒</div>
        <p className="text-sm font-medium text-destructive">{error}</p>
        {onBack && (
          <button onClick={onBack} className="text-xs text-muted-foreground hover:text-foreground">
            ← Go back
          </button>
        )}
      </div>
    )
  }

  if (!team) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
        <span className="text-sm">Connecting to team…</span>
      </div>
    )
  }

  const activeParticipants = participants.filter(p => !p.leftAt)
  const typingList = Object.keys(typingAgents)

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
          <span className="text-sm opacity-40">◈</span>
          <h1 className="font-semibold text-sm truncate">{team.name}</h1>
          <span className={cn('text-[0.65rem] font-medium capitalize', statusColor)}>
            {team.status}
          </span>
        </div>

        {/* Connection indicator */}
        <div className="ml-auto flex items-center gap-3">
          {connected ? (
            <span className="flex items-center gap-1.5 text-[0.65rem] text-green-400">
              <Radio className="size-3 animate-pulse" />
              Live
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[0.65rem] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Reconnecting
            </span>
          )}

          <div className="flex items-center gap-1 text-[0.65rem] text-muted-foreground">
            <Eye className="size-3" />
            <span>Spectating</span>
          </div>

          {/* Mute toggle */}
          <button
            onClick={handleToggleMute}
            className={cn(
              'inline-flex items-center justify-center size-7 rounded-md border border-border transition-colors',
              muted ? 'text-muted-foreground/40 hover:text-foreground' : 'text-green-400 border-green-500/30 bg-green-500/10',
            )}
            title={muted ? 'Unmute sounds' : 'Mute sounds'}
          >
            {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
          </button>

          {/* Replay link for disbanded teams */}
          {team.status === 'disbanded' && onWatchReplay && (
            <button
              onClick={() => onWatchReplay(team.id)}
              className="inline-flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              📼 Watch Replay
            </button>
          )}

          {/* Join as Human button */}
          {!joinedAsHuman && team.status !== 'disbanded' && (
            <button
              onClick={() => setShowJoinForm(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 transition-colors"
            >
              <UserPlus className="size-3.5" />
              Join as Human
            </button>
          )}
          {joinedAsHuman && (
            <span className="text-[0.65rem] text-green-400 font-medium">👤 Joined as {joinName}</span>
          )}
        </div>
      </header>

      {/* Agent cards row */}
      {team.agents.length > 0 && (
        <div className="border-b border-border/50 bg-card/20 px-4 py-2 flex items-start gap-2 overflow-x-auto shrink-0">
          {team.agents.map(agent => (
            <AgentCard
              key={agent.agentId}
              name={agent.name}
              program={agent.program}
              role={agent.role}
              avatar={(agent as { avatar?: string }).avatar}
              personality={(agent as { personality?: string }).personality}
            />
          ))}
        </div>
      )}

      {/* Team description */}
      {team.description && (
        <div className="border-b border-border/50 px-4 py-2 text-xs text-muted-foreground bg-card/40">
          {team.description}
        </div>
      )}

      {/* Join form overlay */}
      {showJoinForm && (
        <div className="border-b border-border bg-card/80 px-4 py-3 flex items-center gap-3">
          <UserPlus className="size-4 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={joinName}
            onChange={e => setJoinName(e.target.value)}
            placeholder="Your display name…"
            className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/30"
            onKeyDown={e => { if (e.key === 'Enter') void handleJoinAsHuman() }}
            autoFocus
          />
          <button
            onClick={() => void handleJoinAsHuman()}
            disabled={joining || !joinName.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {joining ? <Loader2 className="size-3 animate-spin" /> : null}
            Join
          </button>
          <button onClick={() => setShowJoinForm(false)} className="text-xs text-muted-foreground hover:text-foreground">
            Cancel
          </button>
          {joinError && <span className="text-xs text-destructive">{joinError}</span>}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Message feed */}
        <div className="flex flex-1 flex-col overflow-hidden relative">
          <MessageFeed
            messages={messages}
            agents={team.agents}
            participants={activeParticipants}
            readOnly={!joinedAsHuman}
            typingAgents={typingList}
          />

          {/* Typing indicator bar */}
          {typingList.length > 0 && (
            <div className="px-4 py-1.5 border-t border-border/30 flex items-center gap-2 text-xs text-muted-foreground bg-card/40 shrink-0">
              <TypingDots />
              <span>
                {typingList.length === 1
                  ? `${typingList[0]} is typing…`
                  : `${typingList.slice(0, -1).join(', ')} and ${typingList[typingList.length - 1]} are typing…`}
              </span>
            </div>
          )}

          {/* Steer input if joined as human */}
          {joinedAsHuman && (
            <div className="border-t border-border px-4 py-3">
              <SteerInput
                teamId={teamId}
                onSend={handleSendMessage}
                placeholder={`Message as ${joinName}…`}
              />
            </div>
          )}

          {/* Stats overlay */}
          <StatsOverlay team={team} messages={messages} spectatorCount={spectatorCount} />
        </div>

        {/* Sidebar: agents + participants */}
        <aside className="hidden w-52 shrink-0 border-l border-border overflow-y-auto p-3 lg:flex flex-col gap-3">
          <div>
            <h3 className="text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Agents ({team.agents.length})
            </h3>
            <div className="flex flex-col gap-1.5">
              {team.agents.map(agent => (
                <div key={agent.name} className="flex items-center gap-2">
                  <AgentBadge
                    name={agent.name}
                    program={agent.program}
                    role={agent.role}
                    origin={agent.origin}
                    showAvatar
                    avatar={(agent as { avatar?: string }).avatar}
                    personality={(agent as { personality?: string }).personality}
                  />
                  <span className={cn(
                    'ml-auto text-[0.55rem] rounded-full px-1.5 py-0.5 capitalize',
                    agent.status === 'active' ? 'bg-green-500/10 text-green-400' :
                    agent.status === 'done' ? 'bg-muted text-muted-foreground' :
                    'bg-yellow-500/10 text-yellow-400',
                  )}>
                    {agent.status}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {activeParticipants.length > 0 && (
            <div>
              <h3 className="text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                <Users className="inline size-2.5 mr-1" />
                Participants ({activeParticipants.length})
              </h3>
              <div className="flex flex-col gap-1">
                {activeParticipants.map(p => (
                  <div key={p.participantId} className="text-[0.65rem] text-muted-foreground flex items-center gap-1.5">
                    <span>{p.origin === 'human' ? '👤' : '🌐'}</span>
                    <span className="truncate">{p.displayName}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-auto">
            <div className="text-[0.6rem] text-muted-foreground/50 flex items-center gap-1">
              <Eye className="size-2.5" />
              <span>Read-only spectator view</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

/** Animated bouncing dots for typing indicator */
function TypingDots() {
  return (
    <span className="flex items-center gap-0.5">
      <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-[bounce_1s_ease-in-out_infinite]" />
      <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-[bounce_1s_ease-in-out_0.15s_infinite]" />
      <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-[bounce_1s_ease-in-out_0.3s_infinite]" />
    </span>
  )
}
