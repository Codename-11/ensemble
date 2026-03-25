/**
 * StatsOverlay — floating real-time stats for SpectatorView and Monitor.
 * Shows elapsed time, message count, msg/min rate, active agents, spectators.
 * Collapsible — click timer to minimize.
 */
import { useState, useEffect, useRef } from 'react'
import { cn } from '../lib/utils'
import type { AgentForgeTeam, AgentForgeMessage } from '../types'

interface StatsOverlayProps {
  team: AgentForgeTeam
  messages: AgentForgeMessage[]
  spectatorCount?: number
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function calcMsgPerMin(messages: AgentForgeMessage[]): number {
  if (messages.length < 2) return 0
  const now = Date.now()
  const windowMs = 60_000
  const recent = messages.filter(m => now - new Date(m.timestamp).getTime() < windowMs)
  return recent.length
}

export function StatsOverlay({ team, messages, spectatorCount = 0 }: StatsOverlayProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const startRef = useRef(new Date(team.createdAt).getTime())

  // Live elapsed counter
  useEffect(() => {
    startRef.current = new Date(team.createdAt).getTime()
    const tick = () => {
      const end = team.completedAt ? new Date(team.completedAt).getTime() : Date.now()
      setElapsedMs(end - startRef.current)
    }
    tick()
    if (!team.completedAt) {
      const id = setInterval(tick, 1000)
      return () => clearInterval(id)
    }
  }, [team.createdAt, team.completedAt])

  const msgCount = messages.length
  const msgsPerMin = calcMsgPerMin(messages)
  const activeAgents = team.agents.filter(a => a.status === 'active' || a.status === 'spawning').length

  return (
    <div
      className={cn(
        'absolute bottom-4 right-4 z-20 select-none rounded-xl border border-white/10',
        'bg-black/60 backdrop-blur-sm text-white shadow-xl transition-all duration-200',
        collapsed ? 'w-auto' : 'w-44',
      )}
    >
      {/* Timer row — always visible, click to collapse */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        title={collapsed ? 'Expand stats' : 'Collapse stats'}
      >
        <span className="text-xs opacity-60">⏱️</span>
        <span className="font-mono text-sm font-semibold tabular-nums tracking-wider">
          {formatElapsed(elapsedMs)}
        </span>
        {collapsed && (
          <span className="ml-auto text-[0.6rem] opacity-40">▲</span>
        )}
        {!collapsed && (
          <span className="ml-auto text-[0.6rem] opacity-40">▼</span>
        )}
      </button>

      {/* Expanded stats */}
      {!collapsed && (
        <div className="border-t border-white/10 px-3 py-2 flex flex-col gap-1.5">
          <StatRow icon="💬" label="Messages" value={String(msgCount)} />
          <StatRow icon="📊" label="Msg/min" value={String(msgsPerMin)} />
          <StatRow icon="🤖" label="Active agents" value={String(activeAgents)} />
          <StatRow icon="👥" label="Spectators" value={String(spectatorCount)} />
        </div>
      )}
    </div>
  )
}

function StatRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-[0.65rem] opacity-60">
        <span>{icon}</span>
        <span>{label}</span>
      </span>
      <span className="font-mono text-xs font-medium tabular-nums">{value}</span>
    </div>
  )
}
