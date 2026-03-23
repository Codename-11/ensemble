import { useMemo, useState } from 'react'
import { ClipboardList, Send, Sparkles, Wand2 } from 'lucide-react'
import { cn } from '../lib/utils'
import type { EnsembleTeamAgent } from '../types'

type ControlMode = 'steer' | 'dispatch'

type DispatchPreset = {
  label: string
  content: string
}

const STEERING_PRESETS: DispatchPreset[] = [
  {
    label: 'Status update',
    content: 'Share a concise status update: current progress, blockers, and next step.',
  },
  {
    label: 'Focus on tests',
    content: 'Prioritize validation. Run the relevant tests, report failures, and fix regressions before moving on.',
  },
  {
    label: 'Coordinate first',
    content: 'Pause implementation briefly, align with your teammate on scope and handoff boundaries, then continue.',
  },
  {
    label: 'Surface risks',
    content: 'Call out the highest-risk assumptions or edge cases before making the next change.',
  },
]

interface ControlPanelProps {
  agents: EnsembleTeamAgent[]
  onSend: (content: string, to?: string) => Promise<void>
  disabled?: boolean
}

function buildDispatchMessage(params: {
  title: string
  objective: string
  deliverables: string
  constraints: string
}): string {
  const parts = [
    `TASK DISPATCH: ${params.title.trim()}`,
    '',
    `Objective`,
    params.objective.trim(),
  ]

  if (params.deliverables.trim()) {
    parts.push('', 'Deliverables', params.deliverables.trim())
  }

  if (params.constraints.trim()) {
    parts.push('', 'Constraints', params.constraints.trim())
  }

  parts.push('', 'Respond with your plan, then report concrete progress and blockers.')
  return parts.join('\n')
}

export function ControlPanel({ agents, onSend, disabled = false }: ControlPanelProps) {
  const [mode, setMode] = useState<ControlMode>('steer')
  const [steerTarget, setSteerTarget] = useState('team')
  const [steerContent, setSteerContent] = useState('')
  const [dispatchTarget, setDispatchTarget] = useState('team')
  const [dispatchTitle, setDispatchTitle] = useState('')
  const [dispatchObjective, setDispatchObjective] = useState('')
  const [dispatchDeliverables, setDispatchDeliverables] = useState('')
  const [dispatchConstraints, setDispatchConstraints] = useState('')
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  const dispatchPreview = useMemo(() => buildDispatchMessage({
    title: dispatchTitle || 'Untitled task',
    objective: dispatchObjective || 'Describe the immediate objective.',
    deliverables: dispatchDeliverables,
    constraints: dispatchConstraints,
  }), [dispatchConstraints, dispatchDeliverables, dispatchObjective, dispatchTitle])

  async function handleSendSteer(): Promise<void> {
    if (!steerContent.trim() || sendState === 'sending') return
    setSendState('sending')
    try {
      await onSend(steerContent.trim(), steerTarget)
      setSteerContent('')
      setSendState('sent')
      window.setTimeout(() => setSendState('idle'), 1500)
    } catch {
      setSendState('error')
      window.setTimeout(() => setSendState('idle'), 2500)
    }
  }

  async function handleSendDispatch(): Promise<void> {
    if (!dispatchTitle.trim() || !dispatchObjective.trim() || sendState === 'sending') return
    setSendState('sending')
    try {
      await onSend(dispatchPreview, dispatchTarget)
      setDispatchTitle('')
      setDispatchObjective('')
      setDispatchDeliverables('')
      setDispatchConstraints('')
      setSendState('sent')
      window.setTimeout(() => setSendState('idle'), 1500)
    } catch {
      setSendState('error')
      window.setTimeout(() => setSendState('idle'), 2500)
    }
  }

  return (
    <section className="shrink-0 border-t border-border bg-card/95 px-4 py-3 lg:px-6">
      <div className="mb-3 flex items-center gap-2">
        <button
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            mode === 'steer' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setMode('steer')}
          type="button"
        >
          <span className="inline-flex items-center gap-1.5">
            <Wand2 className="size-3.5" />
            Steer
          </span>
        </button>
        <button
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            mode === 'dispatch' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setMode('dispatch')}
          type="button"
        >
          <span className="inline-flex items-center gap-1.5">
            <ClipboardList className="size-3.5" />
            Dispatch Task
          </span>
        </button>
      </div>

      {mode === 'steer' ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {STEERING_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-[var(--border-strong)] hover:text-foreground"
                onClick={() => setSteerContent(preset.content)}
                disabled={disabled || sendState === 'sending'}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="size-3" />
                  {preset.label}
                </span>
              </button>
            ))}
          </div>

          <div className="flex items-end gap-2">
            <select
              className="shrink-0 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              value={steerTarget}
              onChange={(e) => setSteerTarget(e.target.value)}
              disabled={disabled}
            >
              <option value="team">@ team</option>
              {agents.map((agent) => (
                <option key={agent.name} value={agent.name}>
                  @ {agent.name}
                </option>
              ))}
            </select>
            <textarea
              className="min-h-[76px] flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={steerContent}
              onChange={(e) => setSteerContent(e.target.value)}
              placeholder="Steer the team with a concise instruction..."
              disabled={disabled || sendState === 'sending'}
            />
            <button
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void handleSendSteer()}
              disabled={disabled || sendState === 'sending' || !steerContent.trim()}
              type="button"
            >
              <Send className="size-4" />
              Send
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.9fr)]">
          <div className="grid gap-3">
            <div className="flex items-center gap-2">
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                value={dispatchTarget}
                onChange={(e) => setDispatchTarget(e.target.value)}
                disabled={disabled}
              >
                <option value="team">Dispatch to @ team</option>
                {agents.map((agent) => (
                  <option key={agent.name} value={agent.name}>
                    Dispatch to @ {agent.name}
                  </option>
                ))}
              </select>
            </div>
            <input
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              value={dispatchTitle}
              onChange={(e) => setDispatchTitle(e.target.value)}
              placeholder="Task title"
              disabled={disabled || sendState === 'sending'}
            />
            <textarea
              className="min-h-[88px] rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              value={dispatchObjective}
              onChange={(e) => setDispatchObjective(e.target.value)}
              placeholder="Immediate objective"
              disabled={disabled || sendState === 'sending'}
            />
            <textarea
              className="min-h-[72px] rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              value={dispatchDeliverables}
              onChange={(e) => setDispatchDeliverables(e.target.value)}
              placeholder="Deliverables or acceptance criteria"
              disabled={disabled || sendState === 'sending'}
            />
            <textarea
              className="min-h-[72px] rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              value={dispatchConstraints}
              onChange={(e) => setDispatchConstraints(e.target.value)}
              placeholder="Constraints, guardrails, or review notes"
              disabled={disabled || sendState === 'sending'}
            />
            <div className="flex justify-end">
              <button
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void handleSendDispatch()}
                disabled={disabled || sendState === 'sending' || !dispatchTitle.trim() || !dispatchObjective.trim()}
                type="button"
              >
                <ClipboardList className="size-4" />
                Dispatch
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-background/70 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Preview
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
              {dispatchPreview}
            </pre>
          </div>
        </div>
      )}
    </section>
  )
}
