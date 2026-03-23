import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { MessageCircle, ArrowDown, ArrowRight } from 'lucide-react'
import { cn } from '../lib/utils'
import type { EnsembleMessage, EnsembleTeamAgent } from '../types'
import { AgentBadge } from './AgentBadge'

interface MessageFeedProps {
  messages: EnsembleMessage[]
  agents: EnsembleTeamAgent[]
}

/* ── Agent border color mapping ────────────────────────────────── */

const AGENT_BORDER_COLORS: Record<string, string> = {
  codex: 'border-l-agent-codex',
  claude: 'border-l-agent-claude',
  gemini: 'border-l-agent-gemini',
  aider: 'border-l-agent-aider',
}

function getAgentBorderClass(program: string): string {
  const key = program.toLowerCase()
  for (const [name, cls] of Object.entries(AGENT_BORDER_COLORS)) {
    if (key.includes(name)) return cls
  }
  return 'border-l-agent-default'
}

/* ── Timestamp formatting ──────────────────────────────────────── */

function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp)
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return timestamp
  }
}

function formatFullTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp)
    return date.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return timestamp
  }
}

function formatDaySeparator(timestamp: string): string {
  try {
    const date = new Date(timestamp)
    const now = new Date()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)

    if (date.toDateString() === now.toDateString()) return 'Today'
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'

    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

/* ── Content renderer ──────────────────────────────────────────── */

function renderContent(content: string): React.ReactNode {
  const parts = content.split(/(```[\s\S]*?```)/g)
  return parts.map((part, i) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const inner = part.slice(3, -3)
      const newlineIdx = inner.indexOf('\n')
      const lang = newlineIdx >= 0 ? inner.slice(0, newlineIdx).trim() : ''
      const code = newlineIdx >= 0 ? inner.slice(newlineIdx + 1) : inner
      return (
        <pre
          key={i}
          className="my-2 overflow-x-auto rounded-md border border-border bg-[oklch(0.10_0_0)] p-3 font-mono text-xs leading-relaxed whitespace-pre"
        >
          {lang && (
            <span className="mb-1 block text-[0.65rem] uppercase tracking-wider text-muted-foreground/60">
              {lang}
            </span>
          )}
          <code>{code}</code>
        </pre>
      )
    }
    const inlineParts = part.split(/(`[^`]+`)/g)
    return (
      <span key={i}>
        {inlineParts.map((seg, j) => {
          if (seg.startsWith('`') && seg.endsWith('`')) {
            return (
              <code
                key={j}
                className="rounded border border-border bg-[oklch(0.10_0_0)] px-1.5 py-0.5 font-mono text-[0.8em]"
              >
                {seg.slice(1, -1)}
              </code>
            )
          }
          return <span key={j}>{seg}</span>
        })}
      </span>
    )
  })
}

/* ── Helpers ───────────────────────────────────────────────────── */

function getAgentForName(name: string, agents: EnsembleTeamAgent[]): EnsembleTeamAgent | undefined {
  // Try exact match first, then suffix match (message `from` may include team name prefix)
  return agents.find(a => a.name === name || a.agentId === name)
    || agents.find(a => name.endsWith(a.name) || name.endsWith(`-${a.name}`))
}

/** Extract short display name — strip team name prefix (e.g. "1774238417709-codex-1" → "codex-1") */
function shortAgentName(from: string, agents: EnsembleTeamAgent[]): string {
  const agent = getAgentForName(from, agents)
  if (agent) return agent.name
  // Fallback: try to extract the suffix after the team timestamp prefix
  const match = from.match(/^\d+-(.+)$/)
  return match ? match[1] : from
}

function isSameDay(a: string, b: string): boolean {
  try {
    return new Date(a).toDateString() === new Date(b).toDateString()
  } catch {
    return true
  }
}

/* ── Component ─────────────────────────────────────────────────── */

export function MessageFeed({ messages, agents }: MessageFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // Pre-compute grouping metadata
  const groupingMeta = useMemo(() => {
    return messages.map((msg, i) => {
      const prevMsg = i > 0 ? messages[i - 1] : undefined
      const sameSender = prevMsg != null && prevMsg.from === msg.from
      const timeDiff = prevMsg
        ? new Date(msg.timestamp).getTime() - new Date(prevMsg.timestamp).getTime()
        : Infinity
      const grouped = sameSender && timeDiff < 120_000
      const showDaySeparator = !prevMsg || !isSameDay(prevMsg.timestamp, msg.timestamp)
      return { grouped, showDaySeparator }
    })
  }, [messages])

  // Detect user scrolling to toggle autoScroll
  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const { scrollTop, scrollHeight, clientHeight } = container
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 60)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, autoScroll])

  const scrollToBottom = useCallback(() => {
    setAutoScroll(true)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  /* ── Empty state ─────────────────────────────────────────────── */
  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
        <MessageCircle className="size-10 opacity-20" />
        <div className="text-center">
          <p className="text-sm font-medium">Waiting for messages</p>
          <p className="mt-1 max-w-[260px] text-xs opacity-60">
            Messages from agents and the system will appear here.
          </p>
        </div>
        {/* Pulsing dots waiting animation */}
        <div className="flex items-center gap-1.5">
          <span className="size-1.5 animate-[pulse-dot_1.4s_ease-in-out_infinite] rounded-full bg-muted-foreground/40" />
          <span className="size-1.5 animate-[pulse-dot_1.4s_ease-in-out_0.2s_infinite] rounded-full bg-muted-foreground/40" />
          <span className="size-1.5 animate-[pulse-dot_1.4s_ease-in-out_0.4s_infinite] rounded-full bg-muted-foreground/40" />
        </div>
      </div>
    )
  }

  /* ── Message list ────────────────────────────────────────────── */
  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={containerRef}
        className="flex h-full flex-col gap-0.5 overflow-y-auto px-4 py-4 lg:px-6"
      >
        {messages.map((msg, i) => {
          const { grouped, showDaySeparator } = groupingMeta[i]
          const isSystem = msg.from === 'ensemble' || msg.from === 'system'
          const isUser = msg.from === 'user'
          const agent = getAgentForName(msg.from, agents)

          return (
            <div key={msg.id || `msg-${i}`}>
              {/* ── Day separator ─────────────────────────────── */}
              {showDaySeparator && (
                <div className="my-4 flex items-center gap-3 select-none first:mt-0">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-[0.65rem] font-medium uppercase tracking-widest text-muted-foreground/60">
                    {formatDaySeparator(msg.timestamp)}
                  </span>
                  <div className="h-px flex-1 bg-border" />
                </div>
              )}

              {/* ── System / ensemble messages ────────────────── */}
              {isSystem && (
                <div className="my-2 flex justify-center">
                  <div className="flex items-center gap-2 px-3">
                    <div className="h-px w-6 bg-border" />
                    <span
                      className="max-w-[32rem] text-center text-xs italic text-muted-foreground/70"
                      title={formatFullTimestamp(msg.timestamp)}
                    >
                      {renderContent(msg.content)}
                    </span>
                    <div className="h-px w-6 bg-border" />
                  </div>
                </div>
              )}

              {/* ── User messages (right-aligned) ─────────────── */}
              {isUser && (
                <div className={cn('flex justify-end', !grouped && 'mt-3')}>
                  <div className="flex max-w-[70%] flex-col items-end">
                    {!grouped && (
                      <div className="mb-1 flex items-center gap-2 pr-1">
                        <span className="text-xs font-semibold text-foreground">You</span>
                        <span
                          className="font-mono text-[0.65rem] text-muted-foreground/60"
                          title={formatFullTimestamp(msg.timestamp)}
                        >
                          {formatTime(msg.timestamp)}
                        </span>
                      </div>
                    )}
                    <div
                      className={cn(
                        'rounded-xl rounded-tr-sm bg-primary/15 px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words',
                        grouped && 'mt-0.5',
                      )}
                      title={grouped ? formatFullTimestamp(msg.timestamp) : undefined}
                    >
                      {renderContent(msg.content)}
                    </div>
                    {grouped && (
                      <span className="mt-0.5 pr-1 text-[0.6rem] text-muted-foreground/40">
                        {formatTime(msg.timestamp)}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* ── Agent messages (left-aligned with colored border) */}
              {!isSystem && !isUser && (
                <div className={cn('flex', !grouped && 'mt-3')}>
                  <div className="flex max-w-[80%] flex-col">
                    {!grouped && (
                      <div className="mb-1 flex items-center gap-2 pl-3">
                        {agent ? (
                          <AgentBadge name={agent.name} program={agent.program} />
                        ) : (
                          <span className="text-xs font-semibold text-foreground">{shortAgentName(msg.from, agents)}</span>
                        )}
                        {msg.to && msg.to !== 'team' && (
                          <span className="flex items-center gap-0.5 text-[0.65rem] text-muted-foreground/60">
                            <ArrowRight className="size-2.5" />
                            {shortAgentName(msg.to, agents)}
                          </span>
                        )}
                        <span
                          className="font-mono text-[0.65rem] text-muted-foreground/60"
                          title={formatFullTimestamp(msg.timestamp)}
                        >
                          {formatTime(msg.timestamp)}
                        </span>
                      </div>
                    )}
                    <div
                      className={cn(
                        'rounded-lg rounded-tl-sm border-l-2 bg-card px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words',
                        agent ? getAgentBorderClass(agent.program) : 'border-l-agent-default',
                        grouped && 'mt-0.5',
                      )}
                      title={grouped ? formatFullTimestamp(msg.timestamp) : undefined}
                    >
                      {renderContent(msg.content)}
                      {grouped && msg.to && msg.to !== 'team' && (
                        <span className="mt-1 flex items-center gap-0.5 text-[0.6rem] text-muted-foreground/50">
                          <ArrowRight className="size-2" />
                          {msg.to}
                        </span>
                      )}
                    </div>
                    {grouped && (
                      <span className="mt-0.5 pl-3 text-[0.6rem] text-muted-foreground/40">
                        {formatTime(msg.timestamp)}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Scroll-to-bottom fab */}
      {!autoScroll && messages.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 right-4 z-10 inline-flex size-8 items-center justify-center rounded-full border border-border bg-card shadow-lg transition-colors hover:bg-muted"
          title="Scroll to bottom"
        >
          <ArrowDown className="size-4 text-muted-foreground" />
        </button>
      )}
    </div>
  )
}
