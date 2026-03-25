import { useState, useEffect, useCallback } from 'react'
import {
  ArrowLeft,
  Server,
  Shield,
  Bot,
  FileText,
  Info,
  Lock,
  Save,
  RotateCcw,
  Loader2,
  Check,
  AlertCircle,
  Copy,
  Plug,
  BookOpen,
} from 'lucide-react'
import { cn } from '../lib/utils'

// ── Types ──────────────────────────────────────────────────────

interface AgentConfig {
  name: string
  command: string
  flags: string[]
  readyMarker: string
  inputMethod: string
  color: string
  icon: string
  mcpMode?: string
  mcpConfigFlag?: string
}

interface ServerConfig {
  port: number
  host: string
  commMode: string
  autoSummary: boolean
  watchdog: {
    nudgeMs: number
    stallMs: number
    pollMs: number
  }
  completion: {
    windowMs: number
    singleSignalIdleMs: number
  }
  agents: Record<string, AgentConfig>
  dataDir: string
  runtimeDir: string
  about: {
    version: string
    nodeVersion: string
    platform: string
    uptime: number
  }
}

interface Toast {
  type: 'success' | 'error'
  message: string
}

// ── Helpers ────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (days > 0) return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

function msToMinutes(ms: number): number {
  return Math.round(ms / 60000)
}

function minutesToMs(minutes: number): number {
  return minutes * 60000
}

function msToSeconds(ms: number): number {
  return Math.round(ms / 1000)
}

// ── Default prompt template (mirrors buildPromptPreview from agent-forge service) ──

const DEFAULT_PROMPT_TEMPLATE = `You are {agentName} in team "{teamName}" with teammate {teammateNames}.
Task: {description}
ROLE: {role}.
{roleInstructions}
COMMUNICATION: You have MCP tools: team_say, team_read, team_done, team_plan, team_status. Use them directly.
1. IMMEDIATELY greet your teammate with team_say — do this FIRST before any reading or analysis.
2. Communicate FREQUENTLY — share progress every 1-2 minutes, not just when done.
3. After EVERY team_say, run team_read to check for responses.
4. If teammate shared findings, RESPOND to them before continuing your own work.
5. When your work is COMPLETE, call team_done with a summary.
6. To share a structured plan, use team_plan with an array of steps.
START NOW: Run team_say to greet your teammate, then begin work.`

// ── Component ──────────────────────────────────────────────────

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)

  // Editable state
  const [commMode, setCommMode] = useState('mcp')
  const [autoSummary, setAutoSummary] = useState(true)
  const [nudgeMinutes, setNudgeMinutes] = useState(3)
  const [stallMinutes, setStallMinutes] = useState(5)
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_PROMPT_TEMPLATE)
  const [promptDirty, setPromptDirty] = useState(false)

  // Track which sections have unsaved changes
  const [serverDirty, setServerDirty] = useState(false)
  const [watchdogDirty, setWatchdogDirty] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)

  const showToast = useCallback((type: Toast['type'], message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 3000)
  }, [])

  // Fetch config on mount
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await fetch('/api/agent-forge/config')
        if (!res.ok) {
          setFetchError(`Failed to load config: ${res.status}`)
          return
        }
        const data: ServerConfig = await res.json()
        setConfig(data)
        setCommMode(data.commMode)
        setAutoSummary(data.autoSummary)
        setNudgeMinutes(msToMinutes(data.watchdog.nudgeMs))
        setStallMinutes(msToMinutes(data.watchdog.stallMs))
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : 'Failed to load config')
      } finally {
        setLoading(false)
      }
    }
    void fetchConfig()
  }, [])

  // Track dirty state for server section
  useEffect(() => {
    if (!config) return
    setServerDirty(commMode !== config.commMode || autoSummary !== config.autoSummary)
  }, [commMode, autoSummary, config])

  // Track dirty state for watchdog section
  useEffect(() => {
    if (!config) return
    setWatchdogDirty(
      nudgeMinutes !== msToMinutes(config.watchdog.nudgeMs) ||
      stallMinutes !== msToMinutes(config.watchdog.stallMs)
    )
  }, [nudgeMinutes, stallMinutes, config])

  // Save server settings
  const saveServerSettings = async () => {
    setSaving('server')
    try {
      const res = await fetch('/api/agent-forge/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commMode, autoSummary }),
      })
      if (!res.ok) {
        const data = await res.json()
        showToast('error', data.error || 'Failed to save')
        return
      }
      // Update local config so dirty tracking resets
      setConfig(prev => prev ? { ...prev, commMode, autoSummary } : prev)
      showToast('success', 'Server settings saved')
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(null)
    }
  }

  // Save watchdog settings
  const saveWatchdogSettings = async () => {
    setSaving('watchdog')
    try {
      const res = await fetch('/api/agent-forge/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          watchdogNudgeMs: minutesToMs(nudgeMinutes),
          watchdogStallMs: minutesToMs(stallMinutes),
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        showToast('error', data.error || 'Failed to save')
        return
      }
      setConfig(prev => prev ? {
        ...prev,
        watchdog: { ...prev.watchdog, nudgeMs: minutesToMs(nudgeMinutes), stallMs: minutesToMs(stallMinutes) },
      } : prev)
      showToast('success', 'Watchdog settings saved')
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(null)
    }
  }

  // Reset prompt to default
  const resetPrompt = () => {
    setPromptTemplate(DEFAULT_PROMPT_TEMPLATE)
    setPromptDirty(false)
    showToast('success', 'Prompt template reset to default')
  }

  // ── Loading / error states ─────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
        <span className="text-sm">Loading settings...</span>
      </div>
    )
  }

  if (fetchError || !config) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <AlertCircle className="size-8 text-destructive" />
        <p className="text-sm text-destructive">{fetchError || 'Failed to load configuration'}</p>
        <button
          className="mt-2 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          onClick={onBack}
        >
          Go back
        </button>
      </div>
    )
  }

  const agentEntries = Object.entries(config.agents)

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="flex h-full max-h-screen flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <button
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
          Back
        </button>
        <div className="h-4 w-px bg-border" />
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      </header>

      {/* Toast notification */}
      {toast && (
        <div
          className={cn(
            'mx-6 mt-3 flex items-center gap-2 rounded-lg border px-4 py-2 text-xs font-medium transition-all',
            toast.type === 'success'
              ? 'border-green-500/30 bg-green-500/10 text-green-400'
              : 'border-destructive/30 bg-destructive/10 text-destructive'
          )}
        >
          {toast.type === 'success' ? <Check className="size-3.5" /> : <AlertCircle className="size-3.5" />}
          {toast.message}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">

          {/* ── Server + Watchdog — 2 columns on desktop ──────── */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* ── Server Section ──────────────────────────────── */}
            <section className="rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-5 py-3">
                <Server className="size-4 text-primary" />
                <h2 className="text-sm font-semibold">Server</h2>
              </div>
              <div className="space-y-4 p-5">
                {/* Port (read-only) */}
                <SettingsField label="Port" readOnly>
                  <span className="font-mono text-sm text-muted-foreground">{config.port}</span>
                </SettingsField>

                {/* Host (read-only) */}
                <SettingsField label="Host" readOnly>
                  <span className="font-mono text-sm text-muted-foreground">{config.host}</span>
                </SettingsField>

                {/* Communication mode (editable) */}
                <SettingsField label="Comm Mode">
                  <select
                    className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    value={commMode}
                    onChange={(e) => setCommMode(e.target.value)}
                  >
                    <option value="mcp">MCP (Model Context Protocol)</option>
                    <option value="shell">Shell (fallback)</option>
                  </select>
                </SettingsField>

                {/* Auto summary (editable) */}
                <SettingsField label="Auto Summary">
                  <button
                    className={cn(
                      'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                      autoSummary ? 'bg-primary' : 'bg-muted'
                    )}
                    onClick={() => setAutoSummary(!autoSummary)}
                    role="switch"
                    aria-checked={autoSummary}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block size-5 rounded-full bg-white shadow-lg ring-0 transition-transform',
                        autoSummary ? 'translate-x-5' : 'translate-x-0'
                      )}
                    />
                  </button>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {autoSummary ? 'Enabled' : 'Disabled'}
                  </span>
                </SettingsField>

                {/* Data directory (read-only) */}
                <SettingsField label="Data Dir" readOnly>
                  <span className="break-all font-mono text-xs text-muted-foreground">{config.dataDir}</span>
                </SettingsField>

                {/* Runtime directory (read-only) */}
                <SettingsField label="Runtime Dir" readOnly>
                  <span className="break-all font-mono text-xs text-muted-foreground">{config.runtimeDir}</span>
                </SettingsField>

                {/* Save button */}
                {serverDirty && (
                  <div className="flex justify-end pt-2">
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                      onClick={() => void saveServerSettings()}
                      disabled={saving === 'server'}
                    >
                      {saving === 'server' ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Save className="size-3" />
                      )}
                      Save Server Settings
                    </button>
                  </div>
                )}
              </div>
            </section>

            {/* ── Watchdog Section ─────────────────────────────── */}
            <section className="rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-5 py-3">
                <Shield className="size-4 text-yellow-500" />
                <h2 className="text-sm font-semibold">Watchdog</h2>
              </div>
              <div className="space-y-4 p-5">
                {/* Nudge threshold */}
                <SettingsField label="Nudge Threshold">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      className="w-20 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                      value={nudgeMinutes}
                      min={1}
                      onChange={(e) => setNudgeMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                    />
                    <span className="text-xs text-muted-foreground">minutes</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground/70">
                    Time before the watchdog nudges an idle agent
                  </p>
                </SettingsField>

                {/* Stall threshold */}
                <SettingsField label="Stall Threshold">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      className="w-20 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                      value={stallMinutes}
                      min={1}
                      onChange={(e) => setStallMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                    />
                    <span className="text-xs text-muted-foreground">minutes</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground/70">
                    Time after nudge before marking agent as stalled
                  </p>
                </SettingsField>

                {/* Poll interval (read-only) */}
                <SettingsField label="Poll Interval" readOnly>
                  <span className="font-mono text-sm text-muted-foreground">
                    {msToSeconds(config.watchdog.pollMs)}s
                  </span>
                </SettingsField>

                {/* Completion window (read-only) */}
                <SettingsField label="Completion Window" readOnly>
                  <span className="font-mono text-sm text-muted-foreground">
                    {msToSeconds(config.completion.windowMs)}s
                  </span>
                </SettingsField>

                {/* Single signal idle (read-only) */}
                <SettingsField label="Single Signal Idle" readOnly>
                  <span className="font-mono text-sm text-muted-foreground">
                    {msToSeconds(config.completion.singleSignalIdleMs)}s
                  </span>
                </SettingsField>

                {/* Save button */}
                {watchdogDirty && (
                  <div className="flex justify-end pt-2">
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                      onClick={() => void saveWatchdogSettings()}
                      disabled={saving === 'watchdog'}
                    >
                      {saving === 'watchdog' ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Save className="size-3" />
                      )}
                      Save Watchdog Settings
                    </button>
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* ── Agents Section — full width ─────────────────── */}
          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3">
              <Bot className="size-4 text-blue-400" />
              <h2 className="text-sm font-semibold">Agents</h2>
              <span className="ml-auto text-[10px] text-muted-foreground flex items-center gap-1">
                <Lock className="size-2.5" />
                Read-only (edit agents.json to modify)
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="px-5 py-2.5">Agent</th>
                    <th className="px-3 py-2.5">Command</th>
                    <th className="px-3 py-2.5">Flags</th>
                    <th className="px-3 py-2.5">Ready Marker</th>
                    <th className="px-3 py-2.5">Input Method</th>
                    <th className="px-3 py-2.5">MCP</th>
                  </tr>
                </thead>
                <tbody>
                  {agentEntries.map(([key, agent]) => (
                    <tr key={key} className="border-b border-border/50 transition-colors hover:bg-muted/20">
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="text-base" title={agent.color}>{agent.icon}</span>
                          <span className="font-medium text-foreground">{agent.name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground/70">
                          {agent.command}
                        </code>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {agent.flags.length > 0 ? (
                          <code className="font-mono text-[11px]">{agent.flags.join(' ')}</code>
                        ) : (
                          <span className="text-muted-foreground/40">none</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <code className="font-mono text-[11px] text-muted-foreground">{agent.readyMarker}</code>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={cn(
                          'rounded-full px-2 py-0.5 text-[10px] font-medium',
                          agent.inputMethod === 'pasteFromFile'
                            ? 'bg-blue-500/10 text-blue-400'
                            : 'bg-green-500/10 text-green-400'
                        )}>
                          {agent.inputMethod}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {agent.mcpMode ? (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                            {agent.mcpMode}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40">--</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── MCP + System Prompt — 2 columns on desktop ──── */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* ── MCP Section ─────────────────────────────────── */}
            <McpSection config={config} showToast={showToast} />

            {/* ── System Prompt Section ────────────────────────── */}
            <section className="rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-5 py-3">
                <FileText className="size-4 text-green-400" />
                <h2 className="text-sm font-semibold">System Prompt Template</h2>
              </div>
              <div className="space-y-3 p-5">
                <p className="text-[11px] text-muted-foreground">
                  This is the default prompt template sent to agents when a team is created.
                  Variables like <code className="rounded bg-background px-1 text-[10px]">{'{agentName}'}</code>,{' '}
                  <code className="rounded bg-background px-1 text-[10px]">{'{teamName}'}</code>,{' '}
                  <code className="rounded bg-background px-1 text-[10px]">{'{description}'}</code> are replaced at runtime.
                </p>
                <textarea
                  className="h-56 w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  value={promptTemplate}
                  onChange={(e) => {
                    setPromptTemplate(e.target.value)
                    setPromptDirty(e.target.value !== DEFAULT_PROMPT_TEMPLATE)
                  }}
                />
                <div className="flex items-center gap-2 justify-end">
                  {promptDirty && (
                    <button
                      className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      onClick={resetPrompt}
                    >
                      <RotateCcw className="size-3" />
                      Reset to Default
                    </button>
                  )}
                  {promptDirty && (
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                      onClick={() => {
                        // Prompt customization is stored client-side for now
                        // (server-side persistence would require a config file)
                        try {
                          localStorage.setItem('agent-forge:promptTemplate', promptTemplate)
                          setPromptDirty(false)
                          showToast('success', 'Prompt template saved locally')
                        } catch {
                          showToast('error', 'Failed to save prompt template')
                        }
                      }}
                    >
                      <Save className="size-3" />
                      Save Prompt
                    </button>
                  )}
                </div>
              </div>
            </section>
          </div>

          {/* ── Agent Knowledge Section — full width ──────── */}
          <AgentKnowledgeSection showToast={showToast} />

          {/* ── About Section — footer bar ─────────────────── */}
          <section className="rounded-lg border border-border bg-card/50">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-2 px-5 py-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Info className="size-3.5" />
                <span className="font-medium">About</span>
              </div>
              <AboutItem label="Version" value={config.about.version} />
              <AboutItem label="Node.js" value={config.about.nodeVersion} />
              <AboutItem label="Platform" value={config.about.platform} />
              <AboutItem label="Uptime" value={formatUptime(config.about.uptime)} />
            </div>
          </section>

        </div>
      </div>
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────

function SettingsField({
  label,
  readOnly,
  children,
}: {
  label: string
  readOnly?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-4">
      <label className="flex w-36 shrink-0 items-center gap-1.5 pt-1.5 text-xs font-medium text-muted-foreground">
        {readOnly && <Lock className="size-2.5 text-muted-foreground/50" />}
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  )
}

function AboutItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        {label}
      </span>
      <span className="font-mono text-xs text-foreground">{value}</span>
    </div>
  )
}

// ── Agent Knowledge Section ────────────────────────────────────

function AgentKnowledgeSection({ showToast }: { showToast: (type: 'success' | 'error', message: string) => void }) {
  const [skillPath, setSkillPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // Use the current origin for web-accessible URLs
    const baseUrl = window.location.origin
    setSkillPath(`${baseUrl}/docs`)
    fetch('/api/agent-forge/info')
      .then(r => r.json())
      .then((data: { cwd?: string }) => {
        if (data.cwd) {
          // Store local path as fallback for local dev
          setLocalPath(data.cwd.replace(/\\/g, '/') + '/SKILL.md')
        }
      })
      .catch(() => {})
  }, [])

  const [localPath, setLocalPath] = useState<string | null>(null)

  function copyPath() {
    if (!skillPath) return
    navigator.clipboard.writeText(skillPath).then(() => {
      setCopied(true)
      showToast('success', 'URL copied to clipboard')
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {
      showToast('error', 'Failed to copy')
    })
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <BookOpen className="size-4 text-orange-400" />
        <h2 className="text-sm font-semibold">Agent Knowledge</h2>
      </div>
      <div className="space-y-3 p-5">
        <p className="text-[11px] text-muted-foreground">
          Share this file with external agents (OpenClaw, etc.) so they understand the project structure,
          API endpoints, and available MCP tools.
        </p>

        {skillPath && (<>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-background px-3 py-2 font-mono text-xs text-foreground/70">
              {skillPath}
            </code>
            <button
              onClick={copyPath}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors',
                copied
                  ? 'border-green-500/30 bg-green-500/10 text-green-400'
                  : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
              )}
              title="Copy URL for external agents"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? 'Copied' : 'Copy URL'}
            </button>
          </div>
          {localPath && (
            <p className="text-[10px] text-muted-foreground/50">
              Local path: {localPath}
            </p>
          )}
        </>)}
      </div>
    </section>
  )
}

// ── MCP Section ───────────────────────────────────────────────

function McpSection({ config, showToast }: { config: ServerConfig; showToast: (type: 'success' | 'error', message: string) => void }) {
  const [mcpServerPath, setMcpServerPath] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/agent-forge/info')
      .then(r => r.json())
      .then((data: { mcpServerPath?: string }) => {
        if (data.mcpServerPath) setMcpServerPath(data.mcpServerPath)
      })
      .catch(() => {})
  }, [])

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      showToast('success', 'Copied to clipboard')
      setTimeout(() => setCopied(null), 1500)
    }).catch(() => {
      showToast('error', 'Failed to copy')
    })
  }

  const serverPath = mcpServerPath || '<path-to-agent-forge>/mcp/agent-forge-mcp-server.mjs'
  const apiUrl = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`

  const claudeInstallCmd = `claude mcp add agent-forge --env AGENT_FORGE_TEAM_ID=<team-id> --env AGENT_FORGE_AGENT_NAME=<name> --env AGENT_FORGE_API_URL=${apiUrl} -- node ${serverPath}`
  const codexInstallCmd = `codex mcp add agent-forge --env AGENT_FORGE_TEAM_ID=<team-id> --env AGENT_FORGE_AGENT_NAME=<name> --env AGENT_FORGE_API_URL=${apiUrl} -- node ${serverPath}`
  const claudeUninstallCmd = 'claude mcp remove agent-forge'
  const codexUninstallCmd = 'codex mcp remove agent-forge'
  const statusCmd = 'node scripts/mcp-install.mjs status'

  const commands = [
    { key: 'claude-install', label: 'Install for Claude Code', cmd: claudeInstallCmd },
    { key: 'codex-install', label: 'Install for Codex CLI', cmd: codexInstallCmd },
    { key: 'claude-uninstall', label: 'Uninstall from Claude', cmd: claudeUninstallCmd },
    { key: 'codex-uninstall', label: 'Uninstall from Codex', cmd: codexUninstallCmd },
    { key: 'status', label: 'Check status', cmd: statusCmd },
  ]

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Plug className="size-4 text-purple-400" />
        <h2 className="text-sm font-semibold">MCP Server</h2>
      </div>
      <div className="space-y-4 p-5">
        {/* MCP server path */}
        <SettingsField label="Server Path" readOnly>
          <div className="flex items-center gap-2">
            <code className="break-all rounded bg-background px-2 py-1 font-mono text-[11px] text-foreground/70">
              {serverPath}
            </code>
            {mcpServerPath && (
              <button
                onClick={() => copyToClipboard(mcpServerPath, 'path')}
                className="shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:text-foreground"
                title="Copy path"
              >
                <Copy className={cn('size-3', copied === 'path' && 'text-green-400')} />
              </button>
            )}
          </div>
        </SettingsField>

        {/* Info text */}
        <p className="text-[11px] text-muted-foreground">
          The Agent-Forge MCP server allows external Claude Code or Codex sessions to join a team.
          Replace <code className="rounded bg-background px-1 text-[10px]">{'<team-id>'}</code> and{' '}
          <code className="rounded bg-background px-1 text-[10px]">{'<name>'}</code> with actual values.
        </p>

        {/* Commands list */}
        <div className="space-y-3">
          {commands.map(({ key, label, cmd }) => (
            <div key={key} className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
              <div className="flex items-start gap-2">
                <code className="flex-1 break-all rounded bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/70">
                  {cmd}
                </code>
                <button
                  onClick={() => copyToClipboard(cmd, key)}
                  className="mt-1 shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:text-foreground"
                  title="Copy"
                >
                  <Copy className={cn('size-3', copied === key && 'text-green-400')} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
