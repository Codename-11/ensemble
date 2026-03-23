# API Reference

Base URL: `http://127.0.0.1:23000` (configurable via `ENSEMBLE_PORT` and `ENSEMBLE_HOST`)

All responses are JSON with `Content-Type: application/json` unless otherwise noted.

**Rate limiting:** 600 requests per 60-second window per IP address. Exceeding the limit returns HTTP `429`.

**CORS:** Allowed by default for `localhost`, `127.0.0.1`, and `[::1]` on any port. Override with the `ENSEMBLE_CORS_ORIGIN` environment variable (comma-separated origins).

---

## System

### `GET /api/v1/health`

Returns server health status.

**Response (200):**

```json
{ "status": "healthy", "version": "1.0.0" }
```

**Example:**

```bash
curl http://localhost:23000/api/v1/health
```

---

### `GET /api/ensemble/info`

Returns server metadata: current working directory, available agents (from `agents.json`), collaboration templates, and launch defaults.

**Response (200):**

```json
{
  "cwd": "/home/user/my-project",
  "agents": [
    { "id": "codex", "name": "codex", "color": "blue", "icon": "\u25c6" },
    { "id": "claude", "name": "claude", "color": "green", "icon": "\u25cf" },
    { "id": "gemini", "name": "gemini", "color": "yellow", "icon": "\u2605" },
    { "id": "aider", "name": "aider", "color": "magenta", "icon": "\u25b2" },
    { "id": "opencode", "name": "opencode", "color": "cyan", "icon": "\u25a3" }
  ],
  "templates": [
    {
      "id": "review",
      "name": "Code Review",
      "description": "One agent reads and explains the code, the other hunts for bugs.",
      "suggestedTaskPrefix": "Review the following code:",
      "roles": ["REVIEWER", "CRITIC"]
    },
    {
      "id": "implement",
      "name": "Implementation",
      "description": "Lead plans architecture and task breakdown, worker writes code and tests.",
      "suggestedTaskPrefix": "Implement the following feature:",
      "roles": ["ARCHITECT", "DEVELOPER"]
    }
  ],
  "launchDefaults": {
    "minAgents": 2,
    "maxAgents": 4,
    "feedMode": "live"
  },
  "recentDirectories": []
}
```

**Example:**

```bash
curl http://localhost:23000/api/ensemble/info
```

---

## Teams

### `GET /api/ensemble/teams`

List all teams (active, disbanded, completed, etc.).

**Response (200):**

```json
{
  "teams": [
    {
      "id": "abc-123",
      "name": "review-42",
      "description": "Review the auth module",
      "status": "active",
      "agents": [
        {
          "agentId": "a1b2c3",
          "name": "claude-1",
          "program": "claude",
          "role": "REVIEWER",
          "hostId": "my-laptop",
          "status": "active"
        },
        {
          "agentId": "d4e5f6",
          "name": "codex-1",
          "program": "codex",
          "role": "CRITIC",
          "hostId": "my-laptop",
          "status": "active"
        }
      ],
      "createdBy": "user",
      "createdAt": "2026-03-22T10:00:00.000Z",
      "feedMode": "live"
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:23000/api/ensemble/teams
```

---

### `POST /api/ensemble/teams`

Create a new team and spawn agents. Returns immediately with the team in `"forming"` status; agents are spawned asynchronously in the background. The team transitions to `"active"` once all agents are ready and have received their prompts.

**Request body:**

| Field              | Type     | Required | Description                                                    |
|--------------------|----------|----------|----------------------------------------------------------------|
| `name`             | string   | yes      | Short team name (used in session names)                        |
| `description`      | string   | yes      | Task description / prompt for agents                           |
| `agents`           | array    | yes      | Array of `{ program, role?, hostId? }` (min 2)                 |
| `agents[].program` | string   | yes      | Agent program key: `"claude"`, `"codex"`, `"gemini"`, `"aider"`, `"opencode"` |
| `agents[].role`    | string   | no       | Role override (otherwise assigned by template or lead/worker default) |
| `agents[].hostId`  | string   | no       | Target host ID for remote agents (default: `"local"`)          |
| `feedMode`         | string   | no       | `"silent"`, `"summary"`, or `"live"` (default: `"live"`)       |
| `workingDirectory` | string   | no       | Working directory for agent sessions (default: server cwd)     |
| `templateName`     | string   | no       | Collaboration template: `"review"`, `"implement"`, `"research"`, `"debug"` |
| `useWorktrees`     | boolean  | no       | Create isolated git worktrees per agent (default: `false`)     |
| `staged`           | boolean  | no       | Use staged workflow: plan -> exec -> verify (default: `false`) |
| `stagedConfig`     | object   | no       | Override staged workflow timeouts                              |

**`stagedConfig` fields:**

| Field             | Type   | Default  | Description                               |
|-------------------|--------|----------|-------------------------------------------|
| `planTimeoutMs`   | number | 120000   | Max time for the PLAN phase (2 min)       |
| `execTimeoutMs`   | number | 300000   | Max time for the EXEC phase (5 min)       |
| `verifyTimeoutMs` | number | 120000   | Max time for the VERIFY phase (2 min)     |
| `pollIntervalMs`  | number | 5000     | Phase completion check interval (5 sec)   |

**Response (201):**

```json
{
  "team": {
    "id": "abc-123",
    "name": "review-42",
    "description": "Review the auth module for security issues",
    "status": "forming",
    "agents": [
      { "agentId": "", "name": "claude-1", "program": "claude", "role": "REVIEWER", "hostId": "", "status": "spawning" },
      { "agentId": "", "name": "codex-1", "program": "codex", "role": "CRITIC", "hostId": "", "status": "spawning" }
    ],
    "createdBy": "user",
    "createdAt": "2026-03-22T10:00:00.000Z",
    "feedMode": "live"
  }
}
```

**Errors:** `400` for malformed JSON.

**Example:**

```bash
curl -X POST http://localhost:23000/api/ensemble/teams \
  -H "Content-Type: application/json" \
  -d '{
    "name": "review-42",
    "description": "Review the auth module for security issues",
    "agents": [
      { "program": "claude", "role": "REVIEWER" },
      { "program": "codex", "role": "CRITIC" }
    ],
    "templateName": "review",
    "feedMode": "live"
  }'
```

**Example with staged workflow and worktrees:**

```bash
curl -X POST http://localhost:23000/api/ensemble/teams \
  -H "Content-Type: application/json" \
  -d '{
    "name": "feature-auth",
    "description": "Implement OAuth2 login flow",
    "agents": [
      { "program": "claude" },
      { "program": "codex" }
    ],
    "templateName": "implement",
    "workingDirectory": "/home/user/my-project",
    "useWorktrees": true,
    "staged": true,
    "stagedConfig": { "planTimeoutMs": 180000, "execTimeoutMs": 600000 }
  }'
```

---

### `GET /api/ensemble/teams/:id`

Get a single team with its full message history.

**Response (200):**

```json
{
  "team": {
    "id": "abc-123",
    "name": "review-42",
    "status": "active",
    "agents": [ ... ],
    "createdBy": "user",
    "createdAt": "2026-03-22T10:00:00.000Z",
    "feedMode": "live"
  },
  "messages": [
    {
      "id": "msg-1",
      "teamId": "abc-123",
      "from": "ensemble",
      "to": "team",
      "content": "claude-1 (claude @ my-laptop) has joined #review-42",
      "type": "chat",
      "timestamp": "2026-03-22T10:00:01.000Z"
    },
    {
      "id": "msg-2",
      "teamId": "abc-123",
      "from": "claude-1",
      "to": "team",
      "content": "Hello teammate! Let me start reviewing the auth module.",
      "type": "chat",
      "timestamp": "2026-03-22T10:01:00.000Z"
    }
  ]
}
```

**Errors:** `404` if the team does not exist.

**Example:**

```bash
curl http://localhost:23000/api/ensemble/teams/abc-123
```

---

## Messages

### `POST /api/ensemble/teams/:id` (send message)

Send a message to a team. The message is stored in the team feed and delivered to the target agent(s) via their terminal sessions. When `to` is `"team"`, the message is broadcast to all active agents except the sender. When `to` is a specific agent name, only that agent receives it.

**Request body:**

| Field       | Type   | Required | Description                                                                  |
|-------------|--------|----------|------------------------------------------------------------------------------|
| `content`   | string | yes      | Message text                                                                 |
| `to`        | string | no       | Recipient: `"team"` (broadcast) or a specific agent name. Default: `"team"`  |
| `from`      | string | no       | Sender name (default: `"user"`)                                              |
| `id`        | string | no       | Pre-generated message UUID (default: server-generated)                       |
| `timestamp` | string | no       | Pre-generated ISO 8601 timestamp (default: current server time)              |

**Response (200):**

```json
{
  "message": {
    "id": "msg-42",
    "teamId": "abc-123",
    "from": "user",
    "to": "team",
    "content": "Focus on the authentication flow",
    "type": "chat",
    "timestamp": "2026-03-22T10:05:00.000Z"
  }
}
```

**Errors:** `400` for malformed JSON, `404` if the team does not exist.

**Example (broadcast to all agents):**

```bash
curl -X POST http://localhost:23000/api/ensemble/teams/abc-123 \
  -H "Content-Type: application/json" \
  -d '{ "content": "Focus on the authentication flow" }'
```

**Example (direct message to one agent):**

```bash
curl -X POST http://localhost:23000/api/ensemble/teams/abc-123 \
  -H "Content-Type: application/json" \
  -d '{ "content": "Can you review the PR?", "to": "claude-1" }'
```

---

### `GET /api/ensemble/teams/:id/feed`

Get messages for a team, optionally filtered by timestamp for efficient incremental polling.

**Query parameters:**

| Param   | Type   | Description                                              |
|---------|--------|----------------------------------------------------------|
| `since` | string | ISO 8601 timestamp. Only returns messages after this time. |

**Response (200):**

```json
{
  "messages": [
    {
      "id": "msg-1",
      "teamId": "abc-123",
      "from": "claude-1",
      "to": "team",
      "content": "Found a potential SQL injection in the login handler.",
      "type": "chat",
      "timestamp": "2026-03-22T10:03:00.000Z"
    }
  ]
}
```

**Errors:** `404` if the team does not exist.

**Example:**

```bash
# All messages
curl http://localhost:23000/api/ensemble/teams/abc-123/feed

# Incremental: only messages after a given time
curl "http://localhost:23000/api/ensemble/teams/abc-123/feed?since=2026-03-22T10:05:00Z"
```

---

### `GET /api/ensemble/teams/:id/stream` (SSE)

Server-Sent Events stream for real-time team updates. The connection stays open and the server pushes events as they occur. New messages are polled every 2 seconds.

**SSE events:**

| Event       | Payload                            | When                               |
|-------------|------------------------------------|-------------------------------------|
| `init`      | `{ team, messages }`               | Immediately on connect              |
| `message`   | `{ messages: [...] }`             | When new messages are available     |
| `disbanded` | `{ team }`                         | When the team is disbanded          |
| `error`     | `{ error: "..." }`               | On error (team deleted, etc.)       |

The stream closes automatically after `disbanded` or `error` events.

**Example (curl):**

```bash
curl -N http://localhost:23000/api/ensemble/teams/abc-123/stream
```

**Example (JavaScript):**

```javascript
const es = new EventSource('/api/ensemble/teams/abc-123/stream');

es.addEventListener('init', (e) => {
  const { team, messages } = JSON.parse(e.data);
  console.log('Team:', team.name, '- Messages:', messages.length);
});

es.addEventListener('message', (e) => {
  const { messages } = JSON.parse(e.data);
  messages.forEach(m => console.log(`${m.from}: ${m.content}`));
});

es.addEventListener('disbanded', (e) => {
  console.log('Team disbanded');
  es.close();
});
```

**Debug page:** Visit `GET /api/ensemble/teams/:id/stream/test` in a browser for a built-in HTML test page that renders SSE events in real time.

---

## Team Lifecycle

### `POST /api/ensemble/teams/:id/agents` (hot-join)

Add a new agent to an already-running team mid-collaboration. The new agent is spawned, given the last 10 messages as context, and prompted to greet the team and catch up.

**Request body:**

| Field     | Type   | Required | Description                                          |
|-----------|--------|----------|------------------------------------------------------|
| `program` | string | yes      | Agent program key (e.g. `"claude"`, `"codex"`)       |
| `role`    | string | no       | Role assignment (default: `"worker"`)                |

**Response (201):**

```json
{
  "agent": {
    "agentId": "x7y8z9",
    "name": "gemini-1",
    "program": "gemini",
    "role": "reviewer",
    "hostId": "my-laptop",
    "status": "active"
  }
}
```

**Errors:** `400` if `program` is missing or empty, `404` if the team does not exist, `400` if the team is not `active` or `forming`.

**Example:**

```bash
curl -X POST http://localhost:23000/api/ensemble/teams/abc-123/agents \
  -H "Content-Type: application/json" \
  -d '{ "program": "gemini", "role": "reviewer" }'
```

---

### `DELETE /api/ensemble/teams/:id` (disband)

Disband a team. This triggers a multi-step shutdown:

1. Writes a summary file (task, duration, message count, key findings)
2. Scrapes token usage from each agent session
3. Kills all agent terminal sessions
4. Merges git worktrees back to the base branch (if worktrees were used)
5. Cleans up ephemeral runtime files
6. Marks the team as `"disbanded"` with a `completedAt` timestamp
7. Sends a Telegram notification (if configured)

**Response (200):**

```json
{
  "team": {
    "id": "abc-123",
    "status": "disbanded",
    "completedAt": "2026-03-22T10:30:00.000Z",
    ...
  }
}
```

**Errors:** `404` if the team does not exist.

**Example:**

```bash
curl -X DELETE http://localhost:23000/api/ensemble/teams/abc-123
```

---

### `POST /api/ensemble/teams/:id/disband`

Alternative disband endpoint using POST instead of DELETE. Identical behavior to `DELETE /api/ensemble/teams/:id`.

**Example:**

```bash
curl -X POST http://localhost:23000/api/ensemble/teams/abc-123/disband
```

---

### `DELETE /api/ensemble/teams/:id/purge`

Permanently delete a team and all associated data (team record, messages, runtime files). This is destructive and cannot be undone. Use this to clean up old teams that are cluttering the registry.

**Response (200):**

```json
{ "deleted": true }
```

**Errors:** `404` if the team does not exist.

**Example:**

```bash
curl -X DELETE http://localhost:23000/api/ensemble/teams/abc-123/purge
```

---

## Sessions

Low-level session endpoints for direct interaction with agent terminal sessions. The runtime backend is tmux on Linux/macOS and node-pty on Windows.

Session names follow the pattern `<team-name>-<agent-name>` (e.g. `review-42-claude-1`). Only alphanumeric characters, hyphens, underscores, and dots are valid.

### `GET /api/ensemble/sessions`

List all active terminal sessions.

**Response (200):**

```json
{
  "sessions": [
    {
      "name": "review-42-claude-1",
      "exists": true,
      "workingDirectory": "/home/user/my-project"
    },
    {
      "name": "review-42-codex-1",
      "exists": true,
      "workingDirectory": "/home/user/my-project"
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:23000/api/ensemble/sessions
```

---

### `GET /api/ensemble/sessions/:name/output`

Capture recent terminal output from a session.

**Query parameters:**

| Param   | Type   | Default | Description                              |
|---------|--------|---------|------------------------------------------|
| `lines` | number | 200     | Number of lines to capture (1 -- 10000)  |

**Response (200):**

```json
{
  "output": "$ claude --dangerously-skip-permissions\n\nHello! How can I help?\n\n>",
  "session": "review-42-claude-1",
  "exists": true
}
```

If the session does not exist, returns `"exists": false` with empty output (not a 404 error). This allows clients to gracefully handle sessions that have ended.

**Example:**

```bash
curl "http://localhost:23000/api/ensemble/sessions/review-42-claude-1/output?lines=50"
```

---

### `POST /api/ensemble/sessions/:name/input`

Send keystrokes or text to a terminal session.

**Request body:**

| Field     | Type    | Required | Default | Description                                        |
|-----------|---------|----------|---------|----------------------------------------------------|
| `text`    | string  | yes      |         | Text to send to the session                        |
| `enter`   | boolean | no       | `false` | Press Enter after sending the text                 |
| `literal` | boolean | no       | `true`  | Send as literal text (vs. tmux key names like C-c) |

**Response (200):**

```json
{ "ok": true }
```

**Errors:** `400` if `text` is not a string, `404` if the session does not exist.

**Example:**

```bash
# Send a question and press Enter
curl -X POST http://localhost:23000/api/ensemble/sessions/review-42-claude-1/input \
  -H "Content-Type: application/json" \
  -d '{ "text": "What is the status of the review?", "enter": true }'
```

---

### `GET /api/ensemble/sessions/:name/stream` (SSE)

Server-Sent Events stream of terminal output for a single session. Polls every 500ms and pushes `output` events whenever the terminal content changes (diff-based).

**SSE events:**

| Event    | Payload                                      | When                                |
|----------|----------------------------------------------|-------------------------------------|
| `output` | `{ output: "...", timestamp: "..." }`        | Terminal content has changed         |
| `error`  | `{ error: "..." }`                           | Session no longer exists             |

**Example:**

```bash
curl -N http://localhost:23000/api/ensemble/sessions/review-42-claude-1/stream
```

---

## Types Reference

### EnsembleTeam

```typescript
{
  id: string                           // UUID
  name: string                         // Short display name
  description: string                  // Task / prompt
  status: 'forming' | 'active' | 'paused' | 'completed' | 'disbanded' | 'failed'
  agents: EnsembleTeamAgent[]
  createdBy: string                    // Username or hostname
  createdAt: string                    // ISO 8601
  completedAt?: string                 // ISO 8601, set on disband
  feedMode: 'silent' | 'summary' | 'live'
  result?: EnsembleTeamResult
}
```

### EnsembleTeamAgent

```typescript
{
  agentId: string                      // Spawner-assigned ID
  name: string                         // Display name (e.g. "claude-1")
  program: string                      // Program key from agents.json
  role: string                         // LEAD, WORKER, REVIEWER, etc.
  hostId: string                       // Hostname or "local"
  status: 'spawning' | 'active' | 'idle' | 'done' | 'failed'
  worktreePath?: string                // Git worktree path (if enabled)
  worktreeBranch?: string              // Git worktree branch name
}
```

### EnsembleMessage

```typescript
{
  id: string                           // UUID
  teamId: string                       // Parent team ID
  from: string                         // Sender: agent name, "user", or "ensemble"
  to: string                           // Recipient: agent name or "team"
  content: string                      // Message body
  type: 'chat' | 'decision' | 'question' | 'result'
  timestamp: string                    // ISO 8601
  options?: string[]                   // For question-type messages
}
```

### EnsembleTeamResult

```typescript
{
  summary: string
  decisions: string[]
  discoveries: string[]
  filesChanged: string[]
  duration: number                     // Milliseconds
}
```

---

## Error Responses

All errors return a JSON object with an `error` field:

```json
{ "error": "Description of the problem" }
```

| Status | Meaning                                      |
|--------|----------------------------------------------|
| 400    | Bad request (malformed JSON, missing field)  |
| 403    | CORS origin not allowed                      |
| 404    | Team or session not found                    |
| 429    | Rate limit exceeded (600 req/min per IP)     |
| 500    | Internal server error                        |
