/** Mirror of backend types for the web client */

// ── Auth Types ───────────────────────────────────────────────────

export interface AuthUser {
  id: string
  username: string
  displayName?: string
  role: string
}

// ── Open Participation Types ──────────────────────────────────────

export type TeamVisibility = 'private' | 'shared' | 'public'
export type SessionLifecycle = 'ephemeral' | 'persistent'
export type ParticipantOrigin = 'local' | 'remote' | 'human'

export interface RemoteParticipant {
  participantId: string
  displayName: string
  externalAgentId?: string
  capabilities?: string[]
  origin: ParticipantOrigin
  joinedAt: string
  leftAt?: string
  canWrite: boolean
  lastActiveAt: string
}

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
    status: AgentForgeTeam['status']
    visibility: TeamVisibility
    lifecycle: SessionLifecycle
    agent_count: number
    participant_count: number
    created_at: string
  }
}

export interface LobbyTeam {
  id: string
  name: string
  description: string
  status: AgentForgeTeam['status']
  agentCount: number
  participantCount: number
  spectatorCount: number
  createdAt: string
  tags?: string[]
}

export interface ShareLink {
  url: string
  joinToken?: string
  createdAt: string
  expiresAt?: string | null
}

export interface LobbyState {
  teams: LobbyTeam[]
  loading: boolean
  error: string | null
}

export interface SpectatorState {
  teamId: string
  team: AgentForgeTeam | null
  messages: AgentForgeMessage[]
  connected: boolean
  joinedAsHuman: boolean
  participantId?: string
  sessionToken?: string
}

// ── End Open Participation Types ──────────────────────────────────

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

export interface AgentForgeTeam {
  id: string
  name: string
  description: string
  status: 'forming' | 'active' | 'paused' | 'completed' | 'disbanded' | 'failed'
  agents: AgentForgeTeamAgent[]
  createdBy: string
  createdAt: string
  completedAt?: string
  feedMode: 'silent' | 'summary' | 'live'
  result?: AgentForgeTeamResult
  plan?: TeamPlan
  config?: TeamConfig
  visibility: TeamVisibility
  lifecycle: SessionLifecycle
  participants: RemoteParticipant[]
  joinToken?: string
  shareLink?: ShareLink
  tags?: string[]
}

export interface AgentForgeTeamAgent {
  agentId: string
  name: string
  program: string
  role: string
  hostId: string
  status: 'spawning' | 'active' | 'idle' | 'done' | 'failed'
  worktreePath?: string
  worktreeBranch?: string
  origin?: ParticipantOrigin
}

export interface AgentForgeTeamResult {
  summary: string
  decisions: string[]
  discoveries: string[]
  filesChanged: string[]
  duration: number
  aiSummary?: string        // AI-generated summary
  disbandReason?: string    // why the team was disbanded
}

export interface AgentForgeMessage {
  id: string
  teamId: string
  from: string
  to: string
  content: string
  type: 'chat' | 'decision' | 'question' | 'result'
  timestamp: string
  options?: string[]
  participantId?: string
}

export interface CollabTemplateSummary {
  id: string
  name: string
  description: string
  suggestedTaskPrefix: string
  roles: string[]
}

export interface ProjectDirectory {
  name: string
  path: string
}

export interface AgentForgeServerInfo {
  cwd: string
  agents: Array<{
    id: string
    name: string
    color: string
    icon: string
  }>
  templates: CollabTemplateSummary[]
  mcpServerPath?: string
  launchDefaults?: {
    minAgents: number
    maxAgents: number
    feedMode: AgentForgeTeam['feedMode']
  }
  recentDirectories: string[]
  projectDirectories: ProjectDirectory[]
}
