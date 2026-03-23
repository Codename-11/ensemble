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

export interface CreateTeamRequest {
  name: string
  description: string
  agents: Array<{
    program: string
    role?: string
    hostId?: string
  }>
  feedMode?: 'silent' | 'summary' | 'live'
  workingDirectory?: string
  templateName?: string
  useWorktrees?: boolean
  staged?: boolean
  stagedConfig?: StagedWorkflowConfig
  config?: TeamConfig
}

/** Agent permission mode — controls what agents are allowed to do */
export type AgentPermissionMode = 'full' | 'plan-only' | 'review' | 'execute'

export interface TeamConfig {
  /** Permission mode for agents (default: 'full') */
  permissionMode?: AgentPermissionMode
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

export type StagedPhase = 'plan' | 'exec' | 'verify'

export interface StagedWorkflowConfig {
  planTimeoutMs?: number   // Max time for PLAN phase before auto-advancing (default: 120000 = 2min)
  execTimeoutMs?: number   // Max time for EXEC phase before auto-advancing (default: 300000 = 5min)
  verifyTimeoutMs?: number // Max time for VERIFY phase before completing (default: 120000 = 2min)
  pollIntervalMs?: number  // How often to check for phase completion (default: 5000 = 5s)
}

export interface CollabTemplateRole {
  role: string
  focus: string
}

export interface CollabTemplate {
  name: string
  description: string
  suggestedTaskPrefix: string
  roles: CollabTemplateRole[]
}

export interface CollabTemplatesFile {
  templates: Record<string, CollabTemplate>
}
