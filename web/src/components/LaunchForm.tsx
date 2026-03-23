import { useState, useEffect } from 'react'
import { Rocket, Plus, X, Loader2, FolderOpen, ChevronDown, ChevronRight, Crown, ArrowUp, Settings } from 'lucide-react'
import { cn } from '../lib/utils'
import type { CollabTemplateSummary, EnsembleServerInfo, TeamConfig } from '../types'

interface AgentInfo {
  id: string
  name: string
  color: string
  icon: string
}

const FALLBACK_AGENTS: AgentInfo[] = [
  { id: 'codex', name: 'codex', color: 'blue', icon: '◆' },
  { id: 'claude', name: 'claude', color: 'green', icon: '●' },
  { id: 'gemini', name: 'gemini', color: 'yellow', icon: '★' },
  { id: 'aider', name: 'aider', color: 'magenta', icon: '▲' },
  { id: 'opencode', name: 'opencode', color: 'cyan', icon: '▣' },
]

/** Generate a readable session name from the task description */
function generateSessionName(task: string): string {
  // Extract key words from the task, slugify, take first 4 words
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'this', 'that', 'with'].includes(w))
    .slice(0, 4)
    .join('-')
  return slug || `session-${Date.now()}`
}

const DEFAULT_MAX_AGENTS = 4
const DEFAULT_MIN_AGENTS = 2

interface LaunchFormProps {
  onLaunch: (teamId: string) => void
  onCancel: () => void
}

export function LaunchForm({ onLaunch, onCancel }: LaunchFormProps) {
  const [sessionName, setSessionName] = useState('')
  const [task, setTask] = useState('')
  const [agents, setAgents] = useState<string[]>(['codex', 'claude'])
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [staged, setStaged] = useState(false)
  const [useWorktrees, setUseWorktrees] = useState(false)
  const [permissionMode, setPermissionMode] = useState<string>('full')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Server info — auto-fetched
  const [serverCwd, setServerCwd] = useState('')
  const [availableAgents, setAvailableAgents] = useState<AgentInfo[]>(FALLBACK_AGENTS)
  const [recentDirs, setRecentDirs] = useState<string[]>([])
  const [templates, setTemplates] = useState<CollabTemplateSummary[]>([])
  const [minAgents, setMinAgents] = useState(DEFAULT_MIN_AGENTS)
  const [maxAgents, setMaxAgents] = useState(DEFAULT_MAX_AGENTS)
  const [showDirPicker, setShowDirPicker] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [advMaxTurns, setAdvMaxTurns] = useState('')
  const [advTimeoutMin, setAdvTimeoutMin] = useState('')
  const [advNudgeMin, setAdvNudgeMin] = useState('')
  const [advStallMin, setAdvStallMin] = useState('')

  // Fetch server info on mount
  useEffect(() => {
    fetch('/api/ensemble/info')
      .then(r => r.json())
      .then((data: EnsembleServerInfo) => {
        if (data.cwd) setServerCwd(data.cwd)
        if (data.agents?.length) setAvailableAgents(data.agents)
        if (data.recentDirectories?.length) setRecentDirs(data.recentDirectories)
        if (data.templates?.length) setTemplates(data.templates)
        if (data.launchDefaults) {
          setMinAgents(data.launchDefaults.minAgents)
          setMaxAgents(data.launchDefaults.maxAgents)
        }
      })
      .catch(() => { /* use fallbacks */ })
  }, [])

  const canAddAgent = agents.length < maxAgents
  const canRemoveAgent = agents.length > minAgents
  const selectedTemplate = templates.find(template => template.id === templateName)

  function handleAgentChange(index: number, value: string) {
    setAgents(prev => {
      const next = [...prev]
      next[index] = value
      return next
    })
  }

  function handleAddAgent() {
    if (!canAddAgent) return
    const unused = availableAgents.find(a => !agents.includes(a.id))
    setAgents(prev => [...prev, unused?.id ?? availableAgents[0].id])
  }

  function handleRemoveAgent(index: number) {
    if (!canRemoveAgent) return
    setAgents(prev => prev.filter((_, i) => i !== index))
  }

  function handlePromoteLead(index: number) {
    if (index === 0) return // already lead
    setAgents(prev => {
      const next = [...prev]
      const [promoted] = next.splice(index, 1)
      next.unshift(promoted)
      return next
    })
  }

  function selectDirectory(dir: string) {
    setWorkingDirectory(dir)
    setShowDirPicker(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!task.trim()) return

    setSubmitting(true)
    setError(null)

    // Build team config from advanced settings (only include non-empty/non-zero values)
    const config: TeamConfig = {}
    if (permissionMode && permissionMode !== 'full') config.permissionMode = permissionMode as TeamConfig['permissionMode']
    const parsedMaxTurns = parseInt(advMaxTurns, 10)
    if (parsedMaxTurns > 0) config.maxTurns = parsedMaxTurns
    const parsedTimeout = parseFloat(advTimeoutMin)
    if (parsedTimeout > 0) config.timeoutMs = Math.round(parsedTimeout * 60000)
    const parsedNudge = parseFloat(advNudgeMin)
    if (parsedNudge > 0) config.nudgeAfterMs = Math.round(parsedNudge * 60000)
    const parsedStall = parseFloat(advStallMin)
    if (parsedStall > 0) config.stallAfterMs = Math.round(parsedStall * 60000)

    const body = {
      name: sessionName.trim() || generateSessionName(task.trim()),
      description: task.trim(),
      agents: agents.map((program, i) => ({
        program,
        role: i === 0 ? 'lead' : 'worker',
      })),
      feedMode: 'live',
      workingDirectory: workingDirectory.trim() || undefined,
      templateName: templateName || undefined,
      staged,
      useWorktrees,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    }

    try {
      const res = await fetch('/api/ensemble/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `Server responded with ${res.status}`)
      }

      const data = await res.json()
      const teamId: string = data.id ?? data.teamId ?? data.team?.id
      if (!teamId) throw new Error('No team ID returned from server')
      onLaunch(teamId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to launch team')
    } finally {
      setSubmitting(false)
    }
  }

  // Combine recent dirs with server cwd for the picker
  const allDirs = [serverCwd, ...recentDirs.filter(d => d !== serverCwd)].filter(Boolean)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <form
        className="mx-4 flex w-full max-w-3xl flex-col gap-5 overflow-y-auto rounded-xl border border-[var(--border-strong)] bg-card p-6 shadow-2xl max-h-[90vh]"
        onClick={e => e.stopPropagation()}
        onSubmit={e => void handleSubmit(e)}
      >
        <h2 className="text-lg font-semibold tracking-tight">New Session</h2>

        {/* Session name */}
        <label className="flex flex-col gap-2 text-xs font-medium text-muted-foreground">
          Name <span className="font-normal text-muted-foreground/50">(optional — auto-generated if blank)</span>
          <input
            type="text"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            placeholder="e.g. auth-review, api-refactor..."
            value={sessionName}
            onChange={e => setSessionName(e.target.value)}
          />
        </label>

        {/* Task description */}
        <label className="flex flex-col gap-2 text-xs font-medium text-muted-foreground">
          Task
          <textarea
            className="rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            placeholder="Describe the task..."
            value={task}
            onChange={e => setTask(e.target.value)}
            rows={4}
            style={{ resize: 'vertical', minHeight: '80px' }}
            required
            autoFocus
          />
        </label>

        {/* Agent picker */}
        <div className="flex flex-col gap-2 text-xs font-medium text-muted-foreground">
          Agents
          <div className="flex flex-wrap items-center gap-2">
            {agents.map((program, i) => (
              <div
                key={i}
                className={cn(
                  'flex items-center overflow-hidden rounded-lg border bg-background transition-colors focus-within:ring-2 focus-within:ring-primary/30',
                  i === 0 ? 'border-primary/40' : 'border-border',
                )}
              >
                {i === 0 ? (
                  <span className="flex items-center gap-1 border-r border-border px-2 py-1.5 text-[10px] font-semibold text-primary" title="Team lead — drives planning and delegation">
                    <Crown className="size-3" />
                    Lead
                  </span>
                ) : (
                  <button
                    type="button"
                    className="border-r border-border px-2 py-1.5 text-muted-foreground/50 transition-colors hover:text-primary"
                    onClick={() => handlePromoteLead(i)}
                    title="Promote to lead"
                  >
                    <ArrowUp className="size-3" />
                  </button>
                )}
                <select
                  className="cursor-pointer border-none bg-transparent px-3 py-1.5 text-sm text-foreground focus:outline-none"
                  value={program}
                  onChange={e => handleAgentChange(i, e.target.value)}
                >
                  {availableAgents.map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                {canRemoveAgent && (
                  <button
                    type="button"
                    className="border-l border-border px-2 py-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => handleRemoveAgent(i)}
                    title="Remove agent"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
            {canAddAgent && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg border border-dashed border-[var(--border-strong)] px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
                onClick={handleAddAgent}
              >
                <Plus className="size-3" />
                Add agent
              </button>
            )}
          </div>
          <span className="text-[11px] text-muted-foreground/70">
            {agents.length} of {maxAgents} agents selected
          </span>
        </div>

        {/* Launch options */}
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-2 text-xs font-medium text-muted-foreground">
            Collaboration Template
            <select
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              value={templateName}
              onChange={e => setTemplateName(e.target.value)}
            >
              <option value="">Default roles</option>
              {templates.map(template => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
            <span className="min-h-8 text-[11px] leading-relaxed text-muted-foreground/70">
              {selectedTemplate
                ? `${selectedTemplate.description} Roles: ${selectedTemplate.roles.join(' + ')}.`
                : 'Use the built-in lead/worker prompt split.'}
            </span>
          </label>

          <div className="flex flex-col gap-2 text-xs font-medium text-muted-foreground">
            Permission Mode
            <select
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              value={permissionMode}
              onChange={e => setPermissionMode(e.target.value)}
            >
              <option value="full">Full — read, write, execute</option>
              <option value="plan-only">Plan Only — read + analyze, no edits</option>
              <option value="review">Review — read + diff only, no edits</option>
              <option value="execute">Execute — follow the plan, write code</option>
            </select>
            <span className="min-h-6 text-[11px] leading-relaxed text-muted-foreground/70">
              {permissionMode === 'full' && 'Agents can read, write, and execute freely.'}
              {permissionMode === 'plan-only' && 'Agents can only read, analyze, and discuss. No file changes.'}
              {permissionMode === 'review' && 'Agents can only read code and git diffs. No file changes.'}
              {permissionMode === 'execute' && 'Agents follow the plan and make changes. Full write access.'}
            </span>

            <label className="mt-2 flex items-start gap-3 rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground">
              <input
                type="checkbox"
                className="mt-0.5 size-4 rounded border-border bg-background text-primary"
                checked={staged}
                onChange={e => setStaged(e.target.checked)}
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium">Staged workflow</span>
                <span className="text-[11px] leading-relaxed text-muted-foreground">
                  Force plan, then implementation, then verification before completion.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground">
              <input
                type="checkbox"
                className="mt-0.5 size-4 rounded border-border bg-background text-primary"
                checked={useWorktrees}
                onChange={e => setUseWorktrees(e.target.checked)}
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium">Isolated worktrees</span>
                <span className="text-[11px] leading-relaxed text-muted-foreground">
                  Spawn local agents in separate git worktrees when the backend can create them.
                </span>
              </span>
            </label>
          </div>
        </div>

        {/* Working directory — smart picker */}
        <div className="flex flex-col gap-2 text-xs font-medium text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>Working Directory</span>
            {serverCwd && !workingDirectory && (
              <span className="font-normal text-muted-foreground/50">
                defaults to server cwd
              </span>
            )}
          </div>

          <div className="relative">
            <div className="flex items-center gap-1">
              <input
                type="text"
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                placeholder={serverCwd || 'Server working directory'}
                value={workingDirectory}
                onChange={e => setWorkingDirectory(e.target.value)}
              />
              {allDirs.length > 0 && (
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-2 text-muted-foreground transition-colors hover:border-[var(--border-strong)] hover:text-foreground"
                  onClick={() => setShowDirPicker(!showDirPicker)}
                  title="Recent directories"
                >
                  <FolderOpen className="size-3.5" />
                  <ChevronDown className={cn('size-3 transition-transform', showDirPicker && 'rotate-180')} />
                </button>
              )}
            </div>

            {/* Directory dropdown */}
            {showDirPicker && allDirs.length > 0 && (
              <div className="absolute top-full left-0 right-0 z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-card shadow-xl">
                {allDirs.map((dir, i) => (
                  <button
                    key={dir}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/50',
                      i === 0 && 'border-b border-border',
                    )}
                    onClick={() => selectDirectory(dir)}
                  >
                    <FolderOpen className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate text-foreground">{dir}</span>
                    {i === 0 && dir === serverCwd && (
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/50">server cwd</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Advanced Settings */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <Settings className="size-3.5" />
            Advanced Settings
            <ChevronRight className={cn('size-3 transition-transform', showAdvanced && 'rotate-90')} />
          </button>

          {showAdvanced && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/20 p-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Max turns
                <input
                  type="number"
                  min="0"
                  className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  placeholder="100"
                  value={advMaxTurns}
                  onChange={e => setAdvMaxTurns(e.target.value)}
                />
                <span className="text-[10px] text-muted-foreground/50">0 = unlimited</span>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Timeout (minutes)
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  placeholder="10"
                  value={advTimeoutMin}
                  onChange={e => setAdvTimeoutMin(e.target.value)}
                />
                <span className="text-[10px] text-muted-foreground/50">0 = unlimited</span>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Nudge after (minutes)
                <input
                  type="number"
                  min="0.5"
                  step="0.5"
                  className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  placeholder="3"
                  value={advNudgeMin}
                  onChange={e => setAdvNudgeMin(e.target.value)}
                />
                <span className="text-[10px] text-muted-foreground/50">default 3 min</span>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Stall after (minutes)
                <input
                  type="number"
                  min="1"
                  step="0.5"
                  className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  placeholder="5"
                  value={advStallMin}
                  onChange={e => setAdvStallMin(e.target.value)}
                />
                <span className="text-[10px] text-muted-foreground/50">default 5 min</span>
              </label>
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="rounded-lg border border-border px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-[var(--border-strong)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={cn(
              'inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
            disabled={submitting || !task.trim()}
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Rocket className="size-3.5" />
            )}
            {submitting ? 'Launching...' : 'Launch Session'}
          </button>
        </div>
      </form>
    </div>
  )
}
