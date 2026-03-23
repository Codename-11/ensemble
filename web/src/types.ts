/** Mirror of backend types for the web client */

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
