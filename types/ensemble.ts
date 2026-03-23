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

// ── Visibility & Lifecycle ──────────────────────────────────────

/** Team visibility mode — controls discovery, spectating, and join access. */
export type TeamVisibility = 'private' | 'shared' | 'public'

/** Session lifecycle — controls whether a team persists after completion. */
export type SessionLifecycle = 'ephemeral' | 'persistent'

/** Participant origin — how an agent/human was added to the team. */
export type ParticipantOrigin = 'local' | 'remote' | 'human'

// ── Remote Agent ────────────────────────────────────────────────

/**
 * A remote participant (agent or human) that joined via HTTP.
 * Stored alongside local agents in team.participants[].
 */
export interface RemoteParticipant {
  participantId: string
  displayName: string
  externalAgentId?: string
  capabilities?: string[]
  origin: ParticipantOrigin
  joinedAt: string
  leftAt?: string
  canWrite: boolean
  tokenHash?: string
  lastActiveAt: string
}

// ── Join Request / Response ─────────────────────────────────────

export interface JoinTeamRequest {
  agent_name: string
  agent_id?: string
  capabilities?: string[]
  auth_token?: string
}

export interface JoinTeamResponse {
  participant_id: string
  session_token: string
  send_url: string
  poll_url: string
  stream_url: string
  spectate_url: string
  team_info: {
    id: string
    name: string
    description: string
    status: EnsembleTeam['status']
    visibility: TeamVisibility
    lifecycle: SessionLifecycle
    agent_count: number
    participant_count: number
    created_at: string
  }
}

// ── Lobby ───────────────────────────────────────────────────────

export interface LobbyTeam {
  id: string
  name: string
  description: string
  status: EnsembleTeam['status']
  visibility: TeamVisibility
  agentCount: number
  participantCount: number
  spectatorCount: number
  createdAt: string
  tags?: string[]
}

// ── Share Link ──────────────────────────────────────────────────

export interface ShareLink {
  url: string
  joinToken?: string
  createdAt: string
  expiresAt?: string | null
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
  /** Team visibility mode. Default: 'private'. */
  visibility: TeamVisibility
  /** Session lifecycle. Default: 'ephemeral'. */
  lifecycle: SessionLifecycle
  /** Remote participants (agents and humans that joined via HTTP). */
  participants: RemoteParticipant[]
  /** Join token for shared teams. */
  joinToken?: string
  /** Short URL-safe share code. */
  shareCode?: string
  /** Share link metadata. */
  shareLink?: ShareLink
  /** Tags for lobby listing (public teams only). */
  tags?: string[]
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
  /** Participant origin. Default: 'local' for spawned agents. */
  origin?: ParticipantOrigin
  /** Optional avatar emoji or image URL */
  avatar?: string
  /** One-liner personality description */
  personality?: string
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
  /** Participant ID of the sender (set for remote participants). */
  participantId?: string
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
  /** Initial visibility mode. Default: 'private'. */
  visibility?: TeamVisibility
  /** Session lifecycle. Default: 'ephemeral'. */
  lifecycle?: SessionLifecycle
  /** Tags for lobby filtering (when visibility is 'public'). */
  tags?: string[]
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
