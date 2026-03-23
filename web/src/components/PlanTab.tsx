import { useCallback, useState } from 'react'
import { Circle, CircleDot, CheckCircle2, SkipForward, Clock } from 'lucide-react'
import { cn } from '../lib/utils'
import type { TeamPlan, PlanStep } from '../types'

interface PlanTabProps {
  plan: TeamPlan | undefined
  teamId: string
  isActive: boolean
}

const STATUS_ICONS: Record<PlanStep['status'], React.ReactNode> = {
  pending: <Circle className="size-4 text-muted-foreground" />,
  'in-progress': <CircleDot className="size-4 text-blue-400 animate-pulse" />,
  done: <CheckCircle2 className="size-4 text-green-500" />,
  skipped: <SkipForward className="size-4 text-muted-foreground/50" />,
}

const STATUS_LABELS: Record<PlanStep['status'], string> = {
  pending: 'Pending',
  'in-progress': 'In Progress',
  done: 'Done',
  skipped: 'Skipped',
}

const STATUS_CYCLE: PlanStep['status'][] = ['pending', 'in-progress', 'done', 'skipped']

export function PlanTab({ plan, teamId, isActive }: PlanTabProps) {
  const [updating, setUpdating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleToggleStatus = useCallback(async (step: PlanStep) => {
    if (!isActive) return

    // Cycle to the next status
    const currentIdx = STATUS_CYCLE.indexOf(step.status)
    const nextStatus = STATUS_CYCLE[(currentIdx + 1) % STATUS_CYCLE.length]

    setUpdating(step.id)
    setError(null)

    try {
      const res = await fetch(`/api/ensemble/teams/${teamId}/plan/${step.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error || `Failed: ${res.status}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update step')
    } finally {
      setUpdating(null)
    }
  }, [teamId, isActive])

  if (!plan) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center">
          <Circle className="mx-auto mb-3 size-10 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground">
            No plan detected yet. The lead agent's plan will appear here automatically.
          </p>
        </div>
      </div>
    )
  }

  const doneCount = plan.steps.filter(s => s.status === 'done').length
  const detectedDate = new Date(plan.detectedAt)
  const formattedTime = detectedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-4 lg:p-6">
      {/* Plan metadata */}
      <div className="mb-4 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="size-3" />
          Detected {formattedTime}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[0.65rem] font-medium tabular-nums">
          v{plan.version}
        </span>
        <span className="ml-auto tabular-nums">
          {doneCount}/{plan.steps.length} complete
        </span>
      </div>

      {/* Progress bar */}
      <div className="mb-5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-green-500 transition-all duration-300"
          style={{ width: `${plan.steps.length > 0 ? (doneCount / plan.steps.length) * 100 : 0}%` }}
        />
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Steps list */}
      <ul className="flex flex-col gap-1">
        {plan.steps.map(step => {
          const isUpdating = updating === step.id
          return (
            <li
              key={step.id}
              className={cn(
                'group flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-all',
                step.status === 'done'
                  ? 'border-green-500/20 bg-green-500/5'
                  : step.status === 'in-progress'
                    ? 'border-blue-400/20 bg-blue-400/5'
                    : step.status === 'skipped'
                      ? 'border-border/50 bg-muted/30'
                      : 'border-border bg-card',
                isActive && 'cursor-pointer hover:border-primary/30',
                isUpdating && 'opacity-60',
              )}
              onClick={() => { if (!isUpdating) void handleToggleStatus(step) }}
              title={isActive ? `Click to change status (current: ${STATUS_LABELS[step.status]})` : STATUS_LABELS[step.status]}
            >
              {/* Status icon */}
              <div className="mt-0.5 shrink-0">
                {STATUS_ICONS[step.status]}
              </div>

              {/* Step content */}
              <div className="min-w-0 flex-1">
                <p className={cn(
                  'text-sm leading-relaxed',
                  step.status === 'done' && 'text-muted-foreground line-through',
                  step.status === 'skipped' && 'text-muted-foreground/50 line-through',
                )}>
                  <span className="mr-1.5 font-mono text-xs text-muted-foreground/50">
                    {step.index + 1}.
                  </span>
                  {step.text}
                </p>

                {/* Agent assignment + updated time */}
                <div className="mt-1 flex items-center gap-2">
                  {step.agentAssigned && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[0.6rem] font-medium text-primary">
                      {step.agentAssigned}
                    </span>
                  )}
                  {step.updatedAt && (
                    <span className="text-[0.6rem] text-muted-foreground/50">
                      {new Date(step.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  )}
                </div>
              </div>

              {/* Status label on hover */}
              {isActive && (
                <span className="shrink-0 self-center text-[0.6rem] font-medium text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/60">
                  {STATUS_LABELS[step.status]}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
