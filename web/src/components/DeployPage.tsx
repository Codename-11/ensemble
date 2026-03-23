import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ArrowLeft,
  GitBranch,
  GitCommit,
  RefreshCw,
  Rocket,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  Copy,
  Terminal,
  Check,
  AlertCircle,
  History,
  RotateCcw,
  Clock,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Circle,
} from 'lucide-react'
import { cn } from '../lib/utils'

// ── Types ──────────────────────────────────────────────────────

interface DeployStatus {
  commitHash: string
  branch: string
  lastCommitMessage: string
  lastDeployTime: string | null
  serviceRunning: boolean
}

interface UpdateCheckResult {
  upToDate: boolean
  commitsBehind: number
  commits: Array<{
    hash: string
    message: string
    author: string
    date?: string
  }>
  changedFiles: string[]
}

interface DeployOutputLine {
  type: 'step' | 'output' | 'done' | 'error'
  text: string
  timestamp: number
}

interface DeployHistoryEntry {
  id: string
  timestamp: string
  commitHash: string
  commitMessage: string
  status: 'running' | 'success' | 'failed'
  source: 'manual' | 'rollback' | 'webhook'
  duration: number | null
  error: string | null
}

interface Toast {
  type: 'success' | 'error'
  message: string
}

// ── Helpers ────────────────────────────────────────────────────

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function shortenHash(hash: string): string {
  return hash.slice(0, 7)
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ── Component ──────────────────────────────────────────────────

interface DeployPageProps {
  onBack: () => void
}

export function DeployPage({ onBack }: DeployPageProps) {
  // Status
  const [status, setStatus] = useState<DeployStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)

  // Update check
  const [checking, setChecking] = useState(false)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)

  // Deploy
  const [deploying, setDeploying] = useState(false)
  const [deployOutput, setDeployOutput] = useState<DeployOutputLine[]>([])
  const [deploySuccess, setDeploySuccess] = useState(false)
  const [deployError, setDeployError] = useState<string | null>(null)

  // Rollback
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null)
  const [rollbackConfirm, setRollbackConfirm] = useState<string | null>(null)
  const [rollingBack, setRollingBack] = useState(false)

  // Deploy history
  const [deployHistory, setDeployHistory] = useState<DeployHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [expandedHistoryRow, setExpandedHistoryRow] = useState<string | null>(null)

  // Restart overlay
  const [restartOverlay, setRestartOverlay] = useState(false)
  const [restartElapsed, setRestartElapsed] = useState(0)
  const restartStartRef = useRef<number>(0)
  const restartIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // UI
  const [toast, setToast] = useState<Toast | null>(null)
  const [copiedHash, setCopiedHash] = useState(false)
  const outputRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  const showToast = useCallback((type: Toast['type'], message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 3000)
  }, [])

  // ── Fetch status on mount ─────────────────────────────────

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      const res = await fetch('/api/ensemble/deploy/status')
      if (!res.ok) {
        setStatusError(`Failed to load deploy status: ${res.status}`)
        return
      }
      const data: DeployStatus = await res.json()
      setStatus(data)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Failed to load deploy status')
    } finally {
      setStatusLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  // ── Fetch deploy history ────────────────────────────────────

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await fetch('/api/ensemble/deploy/history')
      if (res.ok) {
        const data: DeployHistoryEntry[] = await res.json()
        setDeployHistory(data)
      }
    } catch {
      // silently fail
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchHistory()
  }, [fetchHistory])

  // ── Check for updates ─────────────────────────────────────

  const handleCheckUpdates = async () => {
    setChecking(true)
    setUpdateResult(null)
    try {
      const res = await fetch('/api/ensemble/deploy/check', { method: 'POST' })
      if (!res.ok) {
        showToast('error', `Check failed: ${res.status}`)
        return
      }
      const data: UpdateCheckResult = await res.json()
      setUpdateResult(data)
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Check failed')
    } finally {
      setChecking(false)
    }
  }

  // ── Restart overlay logic ──────────────────────────────────

  const startRestartOverlay = useCallback(() => {
    setRestartOverlay(true)
    restartStartRef.current = Date.now()
    setRestartElapsed(0)

    // Update elapsed timer
    restartIntervalRef.current = setInterval(() => {
      setRestartElapsed(Date.now() - restartStartRef.current)
    }, 500)

    // Poll health endpoint
    healthPollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/v1/health')
        if (res.ok) {
          // Server is back
          dismissRestartOverlay()
          showToast('success', 'Server restarted successfully')
          void fetchStatus()
          void fetchHistory()
        }
      } catch {
        // Server still down, keep polling
      }
    }, 2000)
  }, [fetchStatus, fetchHistory, showToast])

  const dismissRestartOverlay = useCallback(() => {
    setRestartOverlay(false)
    setRestartElapsed(0)
    if (restartIntervalRef.current) {
      clearInterval(restartIntervalRef.current)
      restartIntervalRef.current = null
    }
    if (healthPollRef.current) {
      clearInterval(healthPollRef.current)
      healthPollRef.current = null
    }
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (restartIntervalRef.current) clearInterval(restartIntervalRef.current)
      if (healthPollRef.current) clearInterval(healthPollRef.current)
    }
  }, [])

  // ── Deploy ────────────────────────────────────────────────

  const handleDeploy = () => {
    setDeploying(true)
    setDeployOutput([])
    setDeploySuccess(false)
    setDeployError(null)

    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }

    const es = new EventSource('/api/ensemble/deploy/run')
    eventSourceRef.current = es

    let sawRestartStep = false

    const appendLine = (type: DeployOutputLine['type'], text: string) => {
      setDeployOutput(prev => [...prev, { type, text, timestamp: Date.now() }])
      // Auto-scroll to bottom
      requestAnimationFrame(() => {
        if (outputRef.current) {
          outputRef.current.scrollTop = outputRef.current.scrollHeight
        }
      })
    }

    es.addEventListener('step', (e: MessageEvent) => {
      let text: string
      try {
        const parsed = JSON.parse(e.data)
        text = parsed.message || e.data
      } catch {
        text = e.data
      }
      appendLine('step', text)
      if (text.toLowerCase().includes('restarting service')) {
        sawRestartStep = true
      }
    })

    es.addEventListener('output', (e: MessageEvent) => {
      let text: string
      try {
        const parsed = JSON.parse(e.data)
        text = parsed.message || e.data
      } catch {
        text = e.data
      }
      appendLine('output', text)
    })

    es.addEventListener('done', (e: MessageEvent) => {
      let text: string
      try {
        const parsed = JSON.parse(e.data)
        text = parsed.message || 'Deploy complete'
      } catch {
        text = e.data || 'Deploy complete'
      }
      appendLine('done', text)
      setDeploying(false)
      setDeploySuccess(true)
      es.close()
      eventSourceRef.current = null
      setUpdateResult(null)

      if (sawRestartStep) {
        startRestartOverlay()
      } else {
        void fetchStatus()
        void fetchHistory()
      }
    })

    es.addEventListener('error', (e: MessageEvent) => {
      // SSE error event with data (server-sent)
      if (e.data) {
        let text: string
        try {
          const parsed = JSON.parse(e.data)
          text = parsed.message || e.data
        } catch {
          text = e.data
        }
        appendLine('error', text)
        setDeployError(text)
      }
      setDeploying(false)
      es.close()
      eventSourceRef.current = null
      void fetchHistory()
    })

    // Native EventSource error (connection lost)
    es.onerror = () => {
      // Connection drop after restart step is expected
      if (sawRestartStep) {
        setDeploying(false)
        setDeploySuccess(true)
        es.close()
        eventSourceRef.current = null
        startRestartOverlay()
        return
      }
      if (es.readyState === EventSource.CLOSED || es.readyState === EventSource.CONNECTING) {
        setDeployError('Connection to server lost')
        setDeploying(false)
        es.close()
        eventSourceRef.current = null
      }
    }
  }

  // ── Rollback ────────────────────────────────────────────────

  const handleRollback = async (commitHash: string) => {
    setRollingBack(true)
    setRollbackTarget(commitHash)
    try {
      const res = await fetch('/api/ensemble/deploy/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitHash }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        showToast('success', `Rolled back to ${shortenHash(commitHash)}`)
        startRestartOverlay()
      } else {
        showToast('error', data.error || 'Rollback failed')
      }
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Rollback failed')
    } finally {
      setRollingBack(false)
      setRollbackTarget(null)
      setRollbackConfirm(null)
      void fetchHistory()
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
      }
    }
  }, [])

  // ── Copy commit hash ──────────────────────────────────────

  const copyHash = () => {
    if (!status) return
    navigator.clipboard.writeText(status.commitHash).then(() => {
      setCopiedHash(true)
      showToast('success', 'Commit hash copied')
      setTimeout(() => setCopiedHash(false), 1500)
    }).catch(() => {
      showToast('error', 'Failed to copy')
    })
  }

  // ── Loading / error states ────────────────────────────────

  if (statusLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
        <span className="text-sm">Loading deploy status...</span>
      </div>
    )
  }

  if (statusError || !status) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <AlertCircle className="size-8 text-destructive" />
        <p className="text-sm text-destructive">{statusError || 'Failed to load deploy status'}</p>
        <button
          className="mt-2 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          onClick={onBack}
        >
          Go back
        </button>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────

  const canDeploy = updateResult && !updateResult.upToDate && !deploying

  return (
    <div className="flex h-full max-h-screen flex-col overflow-hidden">
      {/* ── Restart Overlay ────────────────────────────────── */}
      {restartOverlay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 rounded-xl border border-border bg-card p-8 shadow-2xl">
            <Loader2 className="size-10 animate-spin text-primary" />
            <h2 className="text-lg font-semibold">Restarting Server...</h2>
            <p className="text-sm text-muted-foreground">
              {restartElapsed < 30_000
                ? 'Waiting for the server to come back online...'
                : restartElapsed < 120_000
                  ? 'Taking longer than expected...'
                  : 'Server may have failed to restart.'}
            </p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="size-3" />
              {Math.floor(restartElapsed / 1000)}s elapsed
            </div>
            {restartElapsed >= 120_000 && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-xs text-red-400">
                  The server did not respond within 2 minutes.
                </p>
                <button
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  onClick={() => {
                    dismissRestartOverlay()
                    void fetchStatus()
                    void fetchHistory()
                  }}
                >
                  <ExternalLink className="size-3" />
                  Manual Refresh
                </button>
              </div>
            )}
          </div>
        </div>
      )}

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
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Deploy & Updates</h1>
          <p className="text-xs text-muted-foreground">Manage server deployments</p>
        </div>
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

      {/* Rollback confirmation dialog */}
      {rollbackConfirm && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
            <h3 className="text-sm font-semibold">Confirm Rollback</h3>
            <p className="mt-2 text-xs text-muted-foreground">
              This will checkout commit <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-primary">{shortenHash(rollbackConfirm)}</code>, rebuild the web app, and restart the service.
              Any uncommitted changes will be stashed.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                className="rounded-lg px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
                onClick={() => setRollbackConfirm(null)}
                disabled={rollingBack}
              >
                Cancel
              </button>
              <button
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
                onClick={() => void handleRollback(rollbackConfirm)}
                disabled={rollingBack}
              >
                {rollingBack && rollbackTarget === rollbackConfirm ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RotateCcw className="size-3" />
                )}
                {rollingBack ? 'Rolling back...' : 'Rollback'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl space-y-6">

          {/* ── Current Version Card ──────────────────────────── */}
          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3">
              <GitCommit className="size-4 text-primary" />
              <h2 className="text-sm font-semibold">Current Version</h2>
              <div className="ml-auto">
                {status.serviceRunning ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-2.5 py-0.5 text-[10px] font-medium text-green-400">
                    <span className="relative flex size-1.5">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-400 opacity-75" />
                      <span className="relative inline-flex size-1.5 rounded-full bg-green-500" />
                    </span>
                    Running
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-0.5 text-[10px] font-medium text-red-400">
                    <span className="inline-block size-1.5 rounded-full bg-red-500" />
                    Stopped
                  </span>
                )}
              </div>
            </div>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              {/* Commit hash */}
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Commit
                </span>
                <div className="flex items-center gap-2">
                  <code className="rounded bg-background px-2 py-1 font-mono text-sm text-foreground">
                    {shortenHash(status.commitHash)}
                  </code>
                  <button
                    onClick={copyHash}
                    className={cn(
                      'rounded p-1 transition-colors',
                      copiedHash
                        ? 'text-green-400'
                        : 'text-muted-foreground/40 hover:text-foreground'
                    )}
                    title="Copy full commit hash"
                  >
                    {copiedHash ? <Check className="size-3" /> : <Copy className="size-3" />}
                  </button>
                </div>
              </div>

              {/* Branch */}
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Branch
                </span>
                <div className="flex items-center gap-1.5">
                  <GitBranch className="size-3.5 text-muted-foreground" />
                  <span className="font-mono text-sm text-foreground">{status.branch}</span>
                </div>
              </div>

              {/* Last commit message */}
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Last Commit
                </span>
                <p className="text-sm text-foreground/80 leading-snug">
                  {status.lastCommitMessage}
                </p>
              </div>

              {/* Last deploy time */}
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Last Deploy
                </span>
                <span className="text-sm text-foreground/80">
                  {relativeTime(status.lastDeployTime)}
                </span>
              </div>
            </div>
          </section>

          {/* ── Check for Updates ─────────────────────────────── */}
          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3">
              <RefreshCw className={cn('size-4 text-blue-400', checking && 'animate-spin')} />
              <h2 className="text-sm font-semibold">Check for Updates</h2>
            </div>
            <div className="space-y-4 p-5">
              <div className="flex items-center gap-3">
                <button
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  onClick={() => void handleCheckUpdates()}
                  disabled={checking || deploying}
                >
                  {checking ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                  {checking ? 'Checking...' : 'Check for Updates'}
                </button>

                {/* Update result badge */}
                {updateResult && !checking && (
                  updateResult.upToDate ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-3 py-1 text-xs font-medium text-green-400">
                      <CheckCircle2 className="size-3.5" />
                      Up to date
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-400">
                      <AlertTriangle className="size-3.5" />
                      {updateResult.commitsBehind} commit{updateResult.commitsBehind !== 1 ? 's' : ''} behind
                    </span>
                  )
                )}
              </div>

              {/* ── Commit Timeline ─────────────────────────────── */}
              {updateResult && !updateResult.upToDate && updateResult.commits.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-xs font-medium text-muted-foreground">Commit Timeline</h3>
                  <div className="relative pl-6">
                    {/* Timeline line */}
                    <div className="absolute left-[9px] top-2 bottom-2 w-px bg-border" />

                    {/* Remote HEAD */}
                    <div className="relative mb-3 flex items-start gap-3">
                      <div className="absolute -left-6 top-0.5 flex size-[18px] items-center justify-center">
                        <Circle className="size-3 fill-blue-500 text-blue-500" />
                      </div>
                      <div className="flex flex-1 items-start gap-3 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs">
                        <code className="shrink-0 rounded bg-blue-500/10 px-1.5 py-0.5 font-mono text-[11px] text-blue-400">
                          {shortenHash(updateResult.commits[0].hash)}
                        </code>
                        <span className="flex-1 text-foreground/80">{updateResult.commits[0].message}</span>
                        <span className="shrink-0 text-muted-foreground">{updateResult.commits[0].author}</span>
                        {updateResult.commits[0].date && (
                          <span className="shrink-0 text-muted-foreground/60">{relativeTime(updateResult.commits[0].date)}</span>
                        )}
                        <button
                          className="shrink-0 rounded px-2 py-0.5 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-500/10"
                          onClick={() => setRollbackConfirm(updateResult.commits[0].hash)}
                          disabled={rollingBack || deploying}
                          title="Rollback to this commit"
                        >
                          <RotateCcw className="size-3" />
                        </button>
                      </div>
                    </div>

                    {/* Intermediate commits */}
                    {updateResult.commits.slice(1).map((commit) => (
                      <div key={commit.hash} className="relative mb-3 flex items-start gap-3">
                        <div className="absolute -left-6 top-0.5 flex size-[18px] items-center justify-center">
                          <Circle className="size-2.5 fill-muted-foreground/30 text-muted-foreground/30" />
                        </div>
                        <div className="flex flex-1 items-start gap-3 px-3 py-2 text-xs">
                          <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-primary">
                            {shortenHash(commit.hash)}
                          </code>
                          <span className="flex-1 text-foreground/80">{commit.message}</span>
                          <span className="shrink-0 text-muted-foreground">{commit.author}</span>
                          {commit.date && (
                            <span className="shrink-0 text-muted-foreground/60">{relativeTime(commit.date)}</span>
                          )}
                          <button
                            className="shrink-0 rounded px-2 py-0.5 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-500/10"
                            onClick={() => setRollbackConfirm(commit.hash)}
                            disabled={rollingBack || deploying}
                            title="Rollback to this commit"
                          >
                            <RotateCcw className="size-3" />
                          </button>
                        </div>
                      </div>
                    ))}

                    {/* Current HEAD */}
                    <div className="relative flex items-start gap-3">
                      <div className="absolute -left-6 top-0.5 flex size-[18px] items-center justify-center">
                        <Circle className="size-3 fill-green-500 text-green-500" />
                      </div>
                      <div className="flex flex-1 items-start gap-3 rounded-md border border-green-500/20 bg-green-500/5 px-3 py-2 text-xs">
                        <code className="shrink-0 rounded bg-green-500/10 px-1.5 py-0.5 font-mono text-[11px] text-green-400">
                          {shortenHash(status.commitHash)}
                        </code>
                        <span className="flex-1 text-foreground/80">{status.lastCommitMessage}</span>
                        <span className="shrink-0 text-[10px] font-medium text-green-400">Current</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Changed files */}
              {updateResult && !updateResult.upToDate && updateResult.changedFiles.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    Changed Files ({updateResult.changedFiles.length})
                  </h3>
                  <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-background p-3">
                    {updateResult.changedFiles.map((file) => (
                      <div key={file} className="font-mono text-[11px] text-foreground/60 leading-relaxed">
                        {file}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Deploy button (in update section) */}
              {updateResult && !updateResult.upToDate && (
                <div className="pt-2">
                  <button
                    className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-green-500 disabled:opacity-50"
                    onClick={handleDeploy}
                    disabled={!canDeploy}
                  >
                    {deploying ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Rocket className="size-4" />
                    )}
                    {deploying ? 'Deploying...' : 'Deploy Update'}
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* ── Deploy Output ─────────────────────────────────── */}
          {(deployOutput.length > 0 || deploying) && (
            <section className="rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-5 py-3">
                <Terminal className="size-4 text-green-400" />
                <h2 className="text-sm font-semibold">Deploy Output</h2>
                {deploying && (
                  <Loader2 className="ml-auto size-3.5 animate-spin text-primary" />
                )}
              </div>

              {/* Success banner */}
              {deploySuccess && (
                <div className="mx-5 mt-4 flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-2.5 text-sm font-medium text-green-400">
                  <CheckCircle2 className="size-4" />
                  Deploy completed successfully
                </div>
              )}

              {/* Error banner */}
              {deployError && (
                <div className="mx-5 mt-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-medium text-red-400">
                  <XCircle className="size-4" />
                  Deploy failed: {deployError}
                </div>
              )}

              {/* Terminal output */}
              <div
                ref={outputRef}
                className="m-5 max-h-80 overflow-y-auto rounded-md bg-zinc-950 p-4 font-mono text-xs leading-relaxed"
              >
                {deployOutput.map((line, i) => (
                  <div key={i} className={cn(
                    line.type === 'step' && 'font-bold text-foreground mt-2 first:mt-0',
                    line.type === 'output' && 'text-muted-foreground',
                    line.type === 'done' && 'text-green-400 font-medium mt-2',
                    line.type === 'error' && 'text-red-400 font-medium mt-2',
                  )}>
                    {line.type === 'step' && <span className="text-primary mr-1">{'\u2192'}</span>}
                    {line.text}
                  </div>
                ))}
                {deploying && (
                  <span className="inline-block size-2 animate-pulse rounded-full bg-primary mt-1" />
                )}
              </div>
            </section>
          )}

          {/* ── Deploy History ─────────────────────────────────── */}
          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3">
              <History className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Deploy History</h2>
              <button
                className="ml-auto rounded p-1 text-muted-foreground/50 transition-colors hover:text-foreground"
                onClick={() => void fetchHistory()}
                title="Refresh history"
              >
                <RefreshCw className={cn('size-3', historyLoading && 'animate-spin')} />
              </button>
            </div>

            {historyLoading && deployHistory.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span className="ml-2 text-xs">Loading history...</span>
              </div>
            ) : deployHistory.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                No deploy history yet
              </div>
            ) : (
              <div className="divide-y divide-border">
                {/* Table header */}
                <div className="grid grid-cols-[1fr_100px_80px_80px_60px] gap-2 px-5 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  <span>Timestamp</span>
                  <span>Commit</span>
                  <span>Source</span>
                  <span>Status</span>
                  <span>Duration</span>
                </div>

                {deployHistory.map((entry) => (
                  <div key={entry.id}>
                    <button
                      className="grid w-full grid-cols-[1fr_100px_80px_80px_60px] gap-2 px-5 py-2.5 text-left text-xs transition-colors hover:bg-muted/30"
                      onClick={() => setExpandedHistoryRow(expandedHistoryRow === entry.id ? null : entry.id)}
                    >
                      <span className="flex items-center gap-1.5 text-foreground/80">
                        {entry.status === 'failed' ? (
                          <ChevronDown className={cn('size-3 text-muted-foreground transition-transform', expandedHistoryRow !== entry.id && '-rotate-90')} />
                        ) : (
                          <ChevronRight className="size-3 text-transparent" />
                        )}
                        {formatTimestamp(entry.timestamp)}
                      </span>
                      <code className="truncate rounded font-mono text-[11px] text-primary" title={entry.commitHash}>
                        {shortenHash(entry.commitHash)}
                      </code>
                      <span className={cn(
                        'text-[10px] font-medium',
                        entry.source === 'rollback' ? 'text-amber-400' : 'text-muted-foreground'
                      )}>
                        {entry.source}
                      </span>
                      <span>
                        {entry.status === 'success' ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-400">
                            <CheckCircle2 className="size-2.5" />
                            OK
                          </span>
                        ) : entry.status === 'failed' ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">
                            <XCircle className="size-2.5" />
                            Fail
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
                            <Loader2 className="size-2.5 animate-spin" />
                            ...
                          </span>
                        )}
                      </span>
                      <span className="text-muted-foreground">{formatDuration(entry.duration)}</span>
                    </button>

                    {/* Expanded error details */}
                    {expandedHistoryRow === entry.id && entry.status === 'failed' && entry.error && (
                      <div className="border-t border-border/50 bg-red-500/5 px-5 py-3">
                        <div className="flex items-start gap-2">
                          <AlertCircle className="mt-0.5 size-3 shrink-0 text-red-400" />
                          <div className="space-y-1">
                            <p className="text-[10px] font-medium uppercase tracking-wider text-red-400/70">Error Details</p>
                            <p className="font-mono text-[11px] text-red-300/80">{entry.error}</p>
                          </div>
                        </div>
                        {entry.commitMessage && (
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            Commit: {entry.commitMessage}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Expanded commit message for non-failed entries */}
                    {expandedHistoryRow === entry.id && entry.status !== 'failed' && entry.commitMessage && (
                      <div className="border-t border-border/50 bg-muted/20 px-5 py-3">
                        <p className="text-[11px] text-muted-foreground">
                          {entry.commitMessage}
                        </p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

        </div>
      </div>
    </div>
  )
}
