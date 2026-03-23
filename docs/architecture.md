# Agent-Forge — Architecture

## High-Level Overview

```
                              Users
                           /    |    \
                          /     |     \
                    +-----+ +------+ +-----+
                    | CLI | |  SPA | | MCP |
                    +-----+ +------+ +-----+
                         \    |    /
                          \   |   /
                     +--------v--------+
                     |   HTTP Server   |
                     |   server.ts     |
                     |   :23000        |
                     +--------+--------+
                              |
                     +--------v--------+
                     | Agent-Forge Service|
                     | (orchestrator)  |
                     +--+---------+--+-+
                        |         |  |
              +---------+    +----+  +----------+
              v              v                  v
        +-----------+  +-----------+    +-------------+
        | Registry  |  |  Spawner  |    |  Watchdog   |
        | (JSON/    |  | (agent    |    | (idle/stall |
        |  JSONL)   |  |  launch)  |    |  detection) |
        +-----------+  +-----+-----+    +-------------+
                             |
                    +--------v--------+
                    |  Agent Runtime  |
                    |  (tmux / pty)   |
                    +---+----+----+---+
                        |    |    |
                   +----+ +--+--+ +----+
                   | S1 | | S2  | | S3 |
                   +----+ +-----+ +----+
                  claude   codex   gemini
                   CLI      CLI     CLI
```

**S1, S2, S3** = Terminal sessions (tmux panes on Linux/macOS, node-pty processes on Windows)

---

## Component Descriptions

### HTTP Server (`server.ts`)

Lightweight Node.js HTTP server (no framework). Handles:

- REST API for team CRUD, messaging, and session interaction
- Server-Sent Events (SSE) for real-time streaming
- CORS, rate limiting, request routing
- Static file serving (web SPA in production)

Runs on port 23000 by default. All routes are defined in a single request handler with regex-based path matching.

### Web SPA (`web/`)

React + Vite single-page application providing a browser-based dashboard:

- **LaunchForm** -- create teams with agent/template/directory selection
- **Monitor** -- live message feed with SSE subscription
- **TerminalPanel** -- xterm.js-based terminal view of agent sessions
- **SteerInput** -- send messages to teams from the browser
- **ControlPanel** -- disband, hot-join, and team management

Stack: React 19, Zustand (state), Tailwind CSS 4, xterm.js, Vite 6.

### CLI (`cli/ensemble.ts`)

Terminal-based interface for headless operation:

- `agent-forge run "task" [--agents x,y]` -- create and run a team
- `agent-forge monitor [--latest | team-id]` -- live TUI monitor
- `agent-forge teams` -- list all teams
- `agent-forge steer <team-id> <message>` -- send a message
- `agent-forge status` -- server health + active team count

### TUI Monitor (`cli/monitor.ts`)

Rich terminal UI for watching collaborations in real time. Subscribes to the SSE stream and renders a color-coded message feed with agent badges.

### MCP Server (`mcp/ensemble-mcp-server.mjs`)

Model Context Protocol (MCP) stdio server that gives agents native tools for team communication:

| Tool          | Description                              |
|---------------|------------------------------------------|
| `team_say`    | Send a message to teammates              |
| `team_read`   | Read recent messages from the team feed  |
| `team_status` | Check team status and active agents      |

Runs as a child process of each agent. Configured via environment variables:

- `ENSEMBLE_TEAM_ID` -- which team the agent belongs to
- `ENSEMBLE_AGENT_NAME` -- the agent's display name
- `ENSEMBLE_API_URL` -- API base URL (default: `http://localhost:23000`)

Implements the MCP JSON-RPC protocol (version `2024-11-05`) over stdin/stdout.

### Agent-Forge Service (`services/ensemble-service.ts`)

The orchestration brain. Manages the full team lifecycle:

1. **Create** -- validate request, persist team record, spawn agents in background
2. **Spawn pipeline** -- create worktrees (optional) -> spawn sessions -> wait for ready markers -> inject prompts
3. **Message routing** -- store messages, deliver to agent sessions via paste/sendKeys
4. **Auto-disband** -- detect completion signals from agents, idle timeout, then write summary and disband
5. **Hot-join** -- add agents to running teams with catch-up context
6. **Staged workflow** -- optional plan -> exec -> verify phased collaboration

Also handles:
- Telegram notifications on disband (optional, via env vars)
- Token usage scraping from agent sessions
- Worktree merge on disband

### Agent Spawner (`lib/agent-spawner.ts`)

Manages agent session lifecycle:

- Creates terminal sessions via the runtime (tmux/pty)
- Builds and writes MCP configuration files per agent
- Launches agent CLI programs with appropriate flags
- Supports both local and remote agent spawning
- Handles session cleanup on disband

### Agent Runtime (`lib/agent-runtime.ts`)

Abstraction layer over terminal session management. Defines the `AgentRuntime` interface with two implementations:

| Runtime             | Platform       | Backend  |
|---------------------|----------------|----------|
| `TmuxRuntime`       | Linux, macOS   | tmux     |
| `PtySessionManager` | Windows        | node-pty |

Key operations: `createSession`, `killSession`, `sendKeys`, `pasteFromFile`, `capturePane`, `listSessions`.

The correct runtime is auto-selected based on `os.platform()`.

### Agent-Forge Registry (`lib/ensemble-registry.ts`)

File-based persistence layer:

- **Teams** stored in `~/.ensemble/ensemble/teams.json` (JSON array with file-level locking via mkdir lock)
- **Messages** stored per-team in JSONL format at `~/.ensemble/ensemble/messages/<teamId>.jsonl`
- Supports concurrent access with stale lock detection and retry

### Agent Watchdog (`lib/agent-watchdog.ts`)

Background monitor that prevents agent stalls:

- Polls all active teams every 30 seconds
- **Nudge** after configurable idle period (default 180s) -- sends a reminder to the agent
- **Stall** after longer idle (default 300s) -- marks agent as stalled
- Delivers nudges via the same mechanism as regular messages (paste/sendKeys)

### Collab Paths (`lib/collab-paths.ts`)

Shared path contract for runtime file isolation. All ephemeral files live under:

```
<ENSEMBLE_RUNTIME_DIR>/          # default: <os.tmpdir()>/ensemble/
  <teamId>/
    messages.jsonl               # Full message log (used by bridge)
    summary.txt                  # Written on disband
    .finished                    # Cleanup marker
    bridge.pid                   # Bridge process PID
    bridge.log                   # Bridge debug log
    feed.txt                     # Feed cache
    team-id                      # Team ID marker file
    prompts/
      <agent-name>.txt           # Initial prompt per agent
    delivery/
      <session-name>.txt         # Message delivery temp files
```

### Worktree Manager (`lib/worktree-manager.ts`)

Optional git worktree isolation for concurrent file editing:

- Creates a branch `collab/<teamId>/<agentName>` per agent
- Each agent works in an isolated worktree directory
- On disband: merges worktrees back, reports conflicts, cleans up

### Staged Workflow (`lib/staged-workflow.ts`)

Optional structured collaboration mode with three phases:

1. **PLAN** -- agents share plans without making changes (timeout: 2 min default)
2. **EXEC** -- agents implement the agreed plan (timeout: 5 min default)
3. **VERIFY** -- agents cross-review each other's work (timeout: 2 min default)

Phase transitions are detected by pattern-matching agent messages for completion signals.

### Bridge (`scripts/ensemble-bridge.mjs`)

Cross-platform Node.js process that bridges file-based agent communication with the HTTP API:

- Watches `messages.jsonl` for new entries
- POSTs each new message to `POST /api/ensemble/teams/:id`
- Exponential backoff on failures, skip on 4xx, retry on 5xx
- Single-instance guard via PID file

### Launch Script (`scripts/collab-launch.mjs`)

All-in-one team launcher that orchestrates the full startup sequence:

1. Health-check the server
2. Create a team via the API
3. Start the bridge process
4. Open the TUI monitor
5. Wait for agents to become ready

---

## Data Flow

### Agent-to-Agent Message Flow (MCP path)

This is the primary communication path when agents have MCP tools configured:

```
Agent A calls team_say("Found a bug in auth.ts")
       |
       v
MCP Server (child process of Agent A)
       |
       v
POST /api/ensemble/teams/:id  (HTTP to server)
       |
       v
ensemble-service.sendTeamMessage()
  1. Store message in JSONL registry
  2. Identify recipients (all active agents except sender)
  3. For each recipient:
       |
       v
  Write delivery file -> runtime.pasteFromFile() into Agent B's session
       |
       v
Agent B sees: "[Team message from claude-1]: Found a bug in auth.ts"
Agent B calls team_read() to get full context
```

### Agent-to-Agent Message Flow (Bridge/shell path)

Fallback path when MCP is not available (uses shell scripts):

```
Agent A runs: team-say.sh <teamId> <name> team "Found a bug"
       |
       v
Appends JSON line to messages.jsonl (atomic write)
       |
       v
ensemble-bridge.mjs detects new line
       |
       v
POST /api/ensemble/teams/:id  (HTTP)
       |
       v
ensemble-service routes to Agent B's session
       |
       v
Agent B runs: team-read.sh <teamId>
       |
       v
GET /api/ensemble/teams/:id/feed  (HTTP)
```

### Web SPA Real-Time Flow

```
Browser opens SSE connection
       |
       v
GET /api/ensemble/teams/:id/stream
       |
       v
Server sends "init" event (full state)
       |
       v
Server polls getTeamFeed() every 2 seconds
       |
       v
When new messages found: sends "message" event
       |
       v
React component updates via Zustand store
```

### Team Lifecycle State Machine

```
  Creating
     |
     v
  forming -----> disbanded (all agents failed to spawn)
     |
     v
  active ------> disbanded (manual, auto-idle, or auto-complete)
     |
     +---------> failed (unexpected error)
```

**Auto-disband triggers:**
- Two different agents post completion signals within 60 seconds of each other
- One agent posts a completion signal and the team is idle for 120+ seconds
- Completion signals are detected by pattern matching: "done", "complete", "finished", etc.

---

## File Structure

```
ensemble/
|-- server.ts                      # HTTP server (all API routes)
|-- agents.json                    # Agent program definitions (5 agents)
|-- collab-templates.json          # Collaboration templates (4 templates)
|-- package.json                   # Root package (tsx, uuid, node-pty optional)
|-- Dockerfile                     # Multi-stage Docker build
|-- tsconfig.json
|
|-- cli/
|   |-- ensemble.ts                # CLI entry point
|   +-- monitor.ts                 # TUI monitor
|
|-- services/
|   +-- ensemble-service.ts        # Orchestration service (team lifecycle)
|
|-- lib/
|   |-- agent-config.ts            # agents.json loader + program resolver
|   |-- agent-runtime.ts           # AgentRuntime interface + TmuxRuntime
|   |-- agent-spawner.ts           # Agent spawn/kill lifecycle
|   |-- agent-watchdog.ts          # Idle/stall detection
|   |-- cli-style.ts               # Terminal color/style helpers
|   |-- collab-paths.ts            # Runtime file path contract
|   |-- ensemble-client.ts         # HTTP client for Agent-Forge API
|   |-- ensemble-paths.ts          # Data directory paths (~/.ensemble/)
|   |-- ensemble-registry.ts       # JSON/JSONL persistence with locking
|   |-- hosts-config.ts            # Multi-host discovery
|   |-- pty-session-manager.ts     # Windows node-pty runtime
|   |-- staged-workflow.ts         # Plan/exec/verify workflow
|   +-- worktree-manager.ts        # Git worktree isolation
|
|-- types/
|   |-- agent-program.ts           # AgentProgram type definition
|   +-- ensemble.ts                # Team, Message, Agent, Template types
|
|-- mcp/
|   +-- ensemble-mcp-server.mjs    # MCP stdio server (team_say/read/status)
|
|-- scripts/
|   |-- collab-launch.mjs          # Cross-platform team launcher
|   |-- ensemble-bridge.mjs        # File-to-HTTP message bridge
|   |-- setup-claude-code.mjs      # Install /collab skill in Claude Code
|   |-- team-say.mjs               # Shell-based message send
|   |-- team-read.mjs              # Shell-based message read
|   +-- dev.mjs                    # Dev server launcher
|
|-- web/                           # React SPA (Vite + Tailwind)
|   |-- src/
|   |   |-- App.tsx                # Root component
|   |   |-- main.tsx               # Entry point
|   |   |-- hooks/useEnsemble.ts   # API hooks + SSE subscription
|   |   |-- stores/ui-store.ts     # Zustand UI state
|   |   |-- components/
|   |   |   |-- AgentBadge.tsx     # Agent name/color badge
|   |   |   |-- ControlPanel.tsx   # Team management controls
|   |   |   |-- LaunchForm.tsx     # Team creation form
|   |   |   |-- MessageFeed.tsx    # Real-time message display
|   |   |   |-- Monitor.tsx        # Main monitoring view
|   |   |   |-- SteerInput.tsx     # Message input box
|   |   |   +-- TerminalPanel.tsx  # xterm.js terminal viewer
|   |   +-- types.ts               # Frontend type definitions
|   +-- package.json               # SPA dependencies
|
|-- tests/
|   |-- ensemble.test.ts           # Integration tests
|   |-- onboarding-smoke.test.ts   # Smoke tests
|   +-- agent-watchdog.test.ts     # Watchdog unit tests
|
+-- docs/                          # Documentation (this directory)
```

---

## Persistence Architecture

### Data Directory (`~/.ensemble/`)

Controlled by `ENSEMBLE_DATA_DIR` env var. Contains durable state:

```
~/.ensemble/
  ensemble/
    teams.json              # Array of all EnsembleTeam objects
    messages/
      <teamId>.jsonl        # One JSONL file per team
  hosts.json                # Multi-host configuration (optional)
```

### Runtime Directory (`<os.tmpdir()>/ensemble/`)

Controlled by `ENSEMBLE_RUNTIME_DIR` env var. Contains ephemeral state:

```
/tmp/ensemble/              # Linux/macOS
%TEMP%/ensemble/            # Windows
  <teamId>/
    messages.jsonl           # Duplicate for bridge process
    prompts/<agent>.txt      # Initial prompts
    delivery/<session>.txt   # Message delivery temp files
    summary.txt              # Disband summary
    .finished                # Cleanup signal
    bridge.pid / bridge.log  # Bridge process state
```

### Concurrency Control

The registry uses directory-based locking (`teams.json.lock/` created via `mkdir`, which is atomic on all platforms). Stale locks older than 10 seconds are automatically broken. Lock acquisition retries for up to 5 seconds.

---

## Multi-Host Architecture

Agent-Forge supports distributing agents across multiple machines:

1. **hosts.json** defines available hosts with URLs and IDs
2. When creating a team, each agent can specify a `hostId`
3. Local agents use the runtime directly (tmux/pty)
4. Remote agents are spawned via HTTP calls to the remote host's Agent-Forge server
5. Messages to remote agents are delivered via `POST /api/ensemble/sessions/:name/input`
6. The self-host is auto-detected via hostname and local IP matching

---

## Security Model

- All endpoints are localhost-only by default (`127.0.0.1`)
- CORS restricts origins to localhost patterns (configurable)
- Rate limiting prevents abuse (600 req/min per IP)
- Session names are sanitized to prevent command injection
- tmux commands use parameterized input (no shell interpolation)
- No authentication is implemented -- the server is intended for local/trusted-network use
