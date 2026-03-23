import { useCallback, useMemo, useState } from 'react'
import {
  Clock,
  FileText,
  Lightbulb,
  ListChecks,
  Loader2,
  MessageCircle,
  Sparkles,
  Users,
  ChevronDown,
} from 'lucide-react'
import { cn } from '../lib/utils'
import type { EnsembleTeam, EnsembleMessage } from '../types'
import { AgentBadge } from './AgentBadge'

interface TeamSummaryProps {
  team: EnsembleTeam
  messages: EnsembleMessage[]
}

/* ── Status styling helpers ──────────────────────────────────────── */

const STATUS_LABELS: Record<string, string> = {
  completed: 'Completed',
  disbanded: 'Disbanded',
  failed: 'Failed',
  active: 'Active',
  forming: 'Forming',
  paused: 'Paused',
}

const AGENT_STATUS_LABELS: Record<string, string> = {
  spawning: 'Spawning',
  active: 'Active',
  idle: 'Idle',
  done: 'Done',
  failed: 'Failed',
}

const AGENT_BG_COLORS: Record<string, string> = {
  codex: 'border-agent-codex/30 bg-agent-codex/5',
  claude: 'border-agent-claude/30 bg-agent-claude/5',
  gemini: 'border-agent-gemini/30 bg-agent-gemini/5',
  aider: 'border-agent-aider/30 bg-agent-aider/5',
}

function getAgentCardClass(program: string): string {
  const key = program.toLowerCase()
  for (const [name, cls] of Object.entries(AGENT_BG_COLORS)) {
    if (key.includes(name)) return cls
  }
  return 'border-agent-default/30 bg-agent-default/5'
}

/* ── Disband reason helpers ──────────────────────────────────────── */

const DISBAND_REASON_LABELS: Record<string, string> = {
  completed: 'Auto-completed',
  manual: 'Manually disbanded',
  error: 'Error',
  auto: 'Auto-completed',
}

const DISBAND_REASON_COLORS: Record<string, string> = {
  completed: 'bg-green-500/10 text-green-400 border-green-500/20',
  manual: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  error: 'bg-red-500/10 text-red-400 border-red-500/20',
  auto: 'bg-green-500/10 text-green-400 border-green-500/20',
}

/* ── AI summary agent options ─────────────────────────────────────── */

const SUMMARY_AGENTS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini' },
]

/* ── Formatting helpers ──────────────────────────────────────────── */

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

function formatFullDatetime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    })
  } catch {
    return iso
  }
}

/* ── Component ───────────────────────────────────────────────────── */

export function TeamSummary({ team, messages }: TeamSummaryProps) {
  /* ── Message statistics ──────────────────────────────────────── */
  const stats = useMemo(() => {
    const perAgent: Record<string, number> = {}
    for (const msg of messages) {
      perAgent[msg.from] = (perAgent[msg.from] || 0) + 1
    }
    const total = messages.length
    const first = messages.length > 0 ? messages[0].timestamp : undefined
    const last = messages.length > 0 ? messages[messages.length - 1].timestamp : undefined
    return { perAgent, total, first, last }
  }, [messages])

  const duration = useMemo(
    () => formatDuration(team.createdAt, team.completedAt),
    [team.createdAt, team.completedAt],
  )

  /* ── AI summary state ────────────────────────────────────────── */
  const [aiSummary, setAiSummary] = useState<string | undefined>(team.result?.aiSummary)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = useState(SUMMARY_AGENTS[0].id)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [generatedBy, setGeneratedBy] = useState<string | undefined>(
    team.result?.aiSummary ? 'claude' : undefined,
  )
  const [generatedAt, setGeneratedAt] = useState<Date | undefined>(
    team.result?.aiSummary ? new Date() : undefined,
  )

  const handleGenerateSummary = useCallback(async () => {
    setGenerating(true)
    setGenerateError(null)
    try {
      const res = await fetch(`/api/ensemble/teams/${team.id}/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: selectedAgent }),
      })
      const data = await res.json() as { aiSummary?: string; agent?: string; error?: string }
      if (!res.ok) {
        throw new Error(data.error || `Failed: ${res.status}`)
      }
      setAiSummary(data.aiSummary)
      setGeneratedBy(data.agent)
      setGeneratedAt(new Date())
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate summary')
    } finally {
      setGenerating(false)
    }
  }, [team.id, selectedAgent])

  const disbandReason = team.result?.disbandReason

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 lg:px-8">
      {/* ── Header section ──────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-bold tracking-tight">{team.name}</h2>
          <span
            className={cn(
              'rounded-full px-3 py-1 text-xs font-semibold',
              `status-${team.status}`,
            )}
          >
            {STATUS_LABELS[team.status] ?? team.status}
          </span>
          {disbandReason && (
            <span
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs font-medium',
                DISBAND_REASON_COLORS[disbandReason] || 'bg-muted text-muted-foreground border-border',
              )}
            >
              {DISBAND_REASON_LABELS[disbandReason] || disbandReason}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 font-mono">
            <Clock className="size-3.5" />
            Duration: {duration}
          </span>
          <span>Created: {formatFullDatetime(team.createdAt)}</span>
          {team.completedAt && (
            <span>Finished: {formatFullDatetime(team.completedAt)}</span>
          )}
        </div>
      </section>

      {/* ── Task section ────────────────────────────────────────── */}
      {team.description && (
        <section className="flex flex-col gap-2">
          <SectionHeading icon={<FileText className="size-4" />} title="Task" />
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
              {team.description}
            </p>
          </div>
        </section>
      )}

      {/* ── AI Summary section ──────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <SectionHeading icon={<Sparkles className="size-4" />} title="AI Summary" />

        {aiSummary ? (
          <div className="flex flex-col gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
            <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
              {aiSummary}
            </p>
            <div className="flex items-center justify-between border-t border-primary/10 pt-2">
              <span className="text-[0.65rem] text-muted-foreground">
                Generated by {generatedBy || 'claude-sonnet-4'}
                {generatedAt && (
                  <> &middot; {formatTimeSince(generatedAt)}</>
                )}
              </span>
              <button
                onClick={() => void handleGenerateSummary()}
                disabled={generating}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.65rem] text-muted-foreground transition-colors hover:text-foreground"
              >
                {generating ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Sparkles className="size-3" />
                )}
                Regenerate
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border bg-card p-4">
            <p className="text-sm text-muted-foreground">
              Generate an AI-powered summary of this collaboration.
            </p>

            {generateError && (
              <p className="text-xs text-destructive">{generateError}</p>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleGenerateSummary()}
                disabled={generating}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {generating ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                {generating ? 'Generating...' : 'Generate Summary'}
              </button>

              {/* Model picker */}
              <div className="relative">
                <button
                  onClick={() => setShowAgentPicker(!showAgentPicker)}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {SUMMARY_AGENTS.find(m => m.id === selectedAgent)?.label || selectedAgent}
                  <ChevronDown className="size-3" />
                </button>
                {showAgentPicker && (
                  <div className="absolute left-0 top-full z-10 mt-1 w-48 rounded-md border border-border bg-card py-1 shadow-lg">
                    {SUMMARY_AGENTS.map(model => (
                      <button
                        key={model.id}
                        onClick={() => {
                          setSelectedAgent(model.id)
                          setShowAgentPicker(false)
                        }}
                        className={cn(
                          'flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted',
                          model.id === selectedAgent ? 'text-foreground font-medium' : 'text-muted-foreground',
                        )}
                      >
                        {model.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Agents section ──────────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <SectionHeading icon={<Users className="size-4" />} title={`Agents (${team.agents.length})`} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {team.agents.map((agent) => (
            <div
              key={agent.agentId}
              className={cn(
                'flex flex-col gap-1.5 rounded-lg border p-3',
                getAgentCardClass(agent.program),
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <AgentBadge name={agent.name} program={agent.program} size="md" />
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[0.65rem] font-medium',
                    `status-${agent.status}`,
                  )}
                >
                  {AGENT_STATUS_LABELS[agent.status] ?? agent.status}
                </span>
              </div>
              <div className="flex flex-col gap-0.5 pl-4 text-[0.7rem] text-muted-foreground">
                <span>Program: <span className="text-foreground/80">{agent.program}</span></span>
                <span>Role: <span className="text-foreground/80">{agent.role || 'default'}</span></span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Result summary section ──────────────────────────────── */}
      {team.result && (
        <section className="flex flex-col gap-2">
          <SectionHeading icon={<ListChecks className="size-4" />} title="Summary" />
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
            {/* Summary text */}
            <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
              {team.result.summary}
            </p>

            {/* Decisions */}
            {team.result.decisions.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Lightbulb className="size-3.5" />
                  Decisions
                </h4>
                <ul className="flex flex-col gap-1 pl-4">
                  {team.result.decisions.map((d, i) => (
                    <li key={i} className="list-disc text-sm text-foreground/80">{d}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Discoveries */}
            {team.result.discoveries.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Lightbulb className="size-3.5" />
                  Discoveries
                </h4>
                <ul className="flex flex-col gap-1 pl-4">
                  {team.result.discoveries.map((d, i) => (
                    <li key={i} className="list-disc text-sm text-foreground/80">{d}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Files changed */}
            {team.result.filesChanged.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Files changed ({team.result.filesChanged.length})
                </h4>
                <ul className="flex flex-col gap-0.5 pl-1">
                  {team.result.filesChanged.map((f, i) => (
                    <li
                      key={i}
                      className="rounded bg-muted/30 px-2 py-0.5 font-mono text-xs text-foreground/70"
                    >
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Message statistics section ──────────────────────────── */}
      <section className="flex flex-col gap-2">
        <SectionHeading icon={<MessageCircle className="size-4" />} title="Message Statistics" />
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>
              Total messages: <span className="font-semibold text-foreground">{stats.total}</span>
            </span>
            {stats.first && (
              <span>First: {formatFullDatetime(stats.first)}</span>
            )}
            {stats.last && (
              <span>Last: {formatFullDatetime(stats.last)}</span>
            )}
          </div>

          {/* Per-agent breakdown */}
          {stats.total > 0 && (
            <div className="flex flex-col gap-2">
              {Object.entries(stats.perAgent)
                .sort(([, a], [, b]) => b - a)
                .map(([name, count]) => {
                  const pct = stats.total > 0 ? Math.round((count / stats.total) * 100) : 0
                  const agent = team.agents.find(
                    (a) => a.name === name || a.agentId === name,
                  )
                  return (
                    <div key={name} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5">
                          {agent ? (
                            <AgentBadge name={agent.name} program={agent.program} size="sm" />
                          ) : (
                            <span className="text-muted-foreground">{name}</span>
                          )}
                        </span>
                        <span className="font-mono text-muted-foreground">
                          {count} ({pct}%)
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
                        <div
                          className="h-full rounded-full bg-primary/60 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

/* ── Section heading ─────────────────────────────────────────────── */

function SectionHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
      {icon}
      {title}
    </h3>
  )
}

/* ── Time since helper ───────────────────────────────────────────── */

function formatTimeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}
