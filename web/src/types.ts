/** Mirror of backend types for the web client */

export interface TeamConfig {
  /** Max total messages before auto-disband (0 = unlimited) */
  maxTurns?: number
  /** Auto-disband after this many ms of total runtime (0 = unlimited) */
  timeoutMs?: number
  /** Watchdog nudge threshold in ms (default 180000 = 3min) */
  nudgeAfterMs?: number
  /** Watchdog stall threshold in ms (default 300000 = 5min) */
  stallAfterMs?: number
  /** Completion signal idle window in ms (default 60000 = 1min) */
  completionWindowMs?: number
  /** Single signal idle threshold in ms (default 120000 = 2min) */
  singleSignalIdleMs?: number
}

export interface PlanStep {
  id: string
  index: number
  text: string
  status: 'pending' | 'in-progress' | 'done' | 'skipped'
  agentAssigned?: string
  updatedAt?: string
}

export interface TeamPlan {
  steps: PlanStep[]
  sourceMessageId?: string
  detectedAt: string
  version: number
}

export interface EnsembleTeam {
  id: string
  name: string
  description: string
  status: 'forming' | 'active' | 'paused' | 'completed' | 'disbanded' | 'failed'
  agents: EnsembleTeamAgent[]
  createdBy: string
  createdAt: string
  completedAt?: string
  feedMode: 'silent' | 'summary' | 'live'
  result?: EnsembleTeamResult
  plan?: TeamPlan
  config?: TeamConfig
}

export interface EnsembleTeamAgent {
  agentId: string
  name: string
  program: string
  role: string
  hostId: string
  status: 'spawning' | 'active' | 'idle' | 'done' | 'failed'
  worktreePath?: string
  worktreeBranch?: string
}

export interface EnsembleTeamResult {
  summary: string
  decisions: string[]
  discoveries: string[]
  filesChanged: string[]
  duration: number
  aiSummary?: string        // AI-generated summary
  disbandReason?: string    // why the team was disbanded
}

export interface EnsembleMessage {
  id: string
  teamId: string
  from: string
  to: string
  content: string
  type: 'chat' | 'decision' | 'question' | 'result'
  timestamp: string
  options?: string[]
}

export interface CollabTemplateSummary {
  id: string
  name: string
  description: string
  suggestedTaskPrefix: string
  roles: string[]
}

export interface EnsembleServerInfo {
  cwd: string
  agents: Array<{
    id: string
    name: string
    color: string
    icon: string
  }>
  templates: CollabTemplateSummary[]
  launchDefaults?: {
    minAgents: number
    maxAgents: number
    feedMode: EnsembleTeam['feedMode']
  }
  recentDirectories: string[]
}
