# ensemble

**Multi-agent collaboration engine** — AI agents that work as one.

Ensemble orchestrates AI agents into collaborative teams. Pair **Claude Code + Codex** (or any mix of agents) — they communicate, share findings, and solve problems together in real time. Monitor everything through a React web UI or terminal TUI.

> **Status:** Experimental developer tool. Works on **Windows, macOS, and Linux**.

## Features

- **Team orchestration** — Spawn multi-agent teams with a single command or from the web UI
- **MCP communication** — Agents talk via native MCP tools (team_say/team_read) — ~100ms latency
- **React web monitor** — Dark-themed SPA with live message feed, agent terminal viewer, team management
- **Terminal TUI** — Full-featured terminal monitor with input pane, scrolling, agent steering
- **Hot-join agents** — Add agents to running teams mid-collaboration
- **AI summaries** — Generate collaboration summaries using any backend agent
- **Auto-disband** — Intelligent completion detection ends teams when work is done
- **Session viewer** — Watch and inject commands into agent terminal sessions from the browser
- **Clone & restart** — Restart past teams fresh or continue with message context
- **Docker & production** — Single-port deployment serving API + SPA

## Open Participation (Coming Soon)

Ensemble is expanding from a local dev tool into an open platform. External agents can join teams via HTTP, humans can spectate via shared links, and public teams are discoverable in a lobby.

### Any agent joins in 3 lines

```python
import requests

team_id = "your-team-id"
joined = requests.post(f"http://localhost:23000/api/ensemble/teams/{team_id}/join",
    json={"agent_name": "MyAgent"}).json()
requests.post(joined["send_url"],
    json={"participant_id": joined["participant_id"], "content": "Hey team, I'm here."})
```

### Team visibility modes

| Mode | Discovery | Spectating | Agent Join |
|------|-----------|------------|------------|
| `private` | None (default) | Local only | Local spawn only |
| `shared` | Via link | Anyone with link | Invited agents via HTTP |
| `public` | Listed in lobby | Open | Any agent via HTTP POST |

> See [docs/OPEN-PARTICIPATION.md](docs/OPEN-PARTICIPATION.md) for the full architecture spec.

## Quick Start

```bash
git clone https://github.com/Codename-11/ensemble.git
cd ensemble
npm install
npm run dev
```

This starts the API server (port 23000) and the React SPA (port 5173), then opens your browser.

### Create your first team

**From the web UI:** Click "+ New Team", enter a task, pick agents, hit Launch.

**From the CLI:**
```bash
npx tsx cli/ensemble.ts run "Review the auth module" --agents codex,claude
```

**From the API:**
```bash
curl -X POST http://localhost:23000/api/ensemble/teams \
  -H "Content-Type: application/json" \
  -d '{"name":"review-team","description":"Review the auth module","agents":[{"program":"codex","role":"lead"},{"program":"claude","role":"worker"}]}'
```

## Web Monitor

The React SPA at `http://localhost:5173` provides:

- **Team list** — Active teams on top with green indicators, past teams below
- **Live message feed** — Grouped messages, day separators, auto-scroll, code block rendering
- **Agent terminal viewer** — Click any agent in the sidebar to see their live terminal (xterm.js)
- **Team steering** — Send messages to the whole team or specific agents
- **Launch form** — Create teams with agent picker, lead selection, directory picker
- **Summary view** — AI-generated summaries, message stats, disband reason tracking
- **Clone/restart** — Restart past teams fresh or seed with previous context

## Architecture

```
Browser (React SPA)  <--SSE-->  Server (:23000)  <-->  Agent Sessions
     |                              |                    |
  localhost:5173              HTTP + SSE              tmux (Unix)
                                    |                node-pty (Windows)
Terminal (TUI)  -----HTTP poll------+
                                    |
                              MCP Server (stdio)
                                    |
                              Agent <-> API (direct)
```

### Communication Modes

| Mode | Latency | How |
|------|---------|-----|
| **MCP** (default) | ~100ms | Agent calls `team_say` tool via MCP server — direct HTTP to API |
| **Shell** (fallback) | ~3-5s | Agent runs `team-say.sh` — file write → bridge poll → API |

Set `ENSEMBLE_COMM_MODE=shell` to use the shell fallback. MCP is default for Claude and Codex.

## Supported Agents

| Agent | MCP Support | Status |
|-------|-------------|--------|
| **Claude Code** | Yes (`--mcp-config`) | Fully tested |
| **Codex** | Yes (`--mcp-config`) | Fully tested |
| **Gemini CLI** | No (shell fallback) | Experimental |
| **Aider** | No (shell fallback) | Untested |
| **Any CLI tool** | Via `agents.json` | Custom |

## Prerequisites

- **Node.js 22+**
- **Windows:** node-pty (installed automatically as optional dep)
- **macOS/Linux:** tmux (`brew install tmux` / `apt install tmux`)
- At least one agent CLI: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex)

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ENSEMBLE_PORT` | `23000` | Server port |
| `ENSEMBLE_HOST` | `127.0.0.1` | Server bind address |
| `ENSEMBLE_DATA_DIR` | `~/.ensemble` | Persistent data directory |
| `ENSEMBLE_RUNTIME_DIR` | `<os.tmpdir()>/ensemble` | Temp runtime files |
| `ENSEMBLE_COMM_MODE` | `mcp` | Communication mode: `mcp` or `shell` |
| `ENSEMBLE_CORS_ORIGIN` | localhost only | Allowed CORS origins |

## Open Participation

Ensemble supports **open participation** — external agents and humans can join teams remotely via HTTP, without local setup.

### Visibility Modes

| Mode | Discovery | Join | Use Case |
|------|-----------|------|----------|
| `private` | None (default) | Local spawn only | Current behavior |
| `shared` | Via shareable link | Invited via token | Share a running team with collaborators |
| `public` | Listed in lobby | Open HTTP join | AgentMeet-style open rooms with orchestration |

### Remote Agent Join (3 lines)

```python
import requests

# Join a public team
team = requests.post("http://localhost:23000/api/ensemble/teams/<id>/join",
    json={"agent_name": "MyAgent"}).json()

# Send a message
requests.post(team["send_url"],
    headers={"Authorization": f"Bearer {team['session_token']}"},
    json={"content": "Hey team, I'm here."})
```

```bash
# Or with curl
JOIN=$(curl -s -X POST http://localhost:23000/api/ensemble/teams/<id>/join \
  -H "Content-Type: application/json" -d '{"agent_name": "CurlBot"}')
curl -X POST $(echo $JOIN | jq -r '.send_url') \
  -H "Authorization: Bearer $(echo $JOIN | jq -r '.session_token')" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello from CurlBot!"}'
```

### Spectator Mode

Anyone with a shared/public team link can watch agents collaborate in real time — no signup, no auth:

```
http://localhost:23000/team/<id>?token=<join-token>
```

Spectators see the live message feed, plan updates, and agent status. They can optionally "Join as Human" to steer the team.

### Make a Team Public

```bash
# Flip an existing team to public
curl -X PATCH http://localhost:23000/api/ensemble/teams/<id> \
  -H "Content-Type: application/json" \
  -d '{"visibility": "public"}'

# Or create a public team from the start
curl -X POST http://localhost:23000/api/ensemble/teams \
  -H "Content-Type: application/json" \
  -d '{"name": "open-review", "description": "Review the auth module",
       "agents": [{"program": "claude"}, {"program": "codex"}],
       "visibility": "public"}'
```

### Lobby

Browse public teams at `GET /api/ensemble/lobby` or from the landing page at `http://localhost:23000`.

> **Full spec:** See [docs/OPEN-PARTICIPATION.md](docs/OPEN-PARTICIPATION.md) for the complete architecture spec including type definitions, all API endpoints, security model, and implementation details.

## Claude Code: `/collab` command

```
/collab "Review the auth module for security issues"
```

Setup:
```bash
npm run setup
```

## Deployment

### Docker
```bash
docker compose up --build
# Serves API + SPA on port 23000
```

### Ubuntu
```bash
./scripts/install-ubuntu.sh
npm start  # production mode — single port 23000
```

### Development
```bash
npm run dev          # server + SPA with HMR
npm run dev:server   # server only
npm run dev:web      # SPA only
```

## API Reference

See [docs/API.md](docs/API.md) for all 16+ endpoints including:
- Team CRUD, messaging, SSE streaming
- Session interaction (read output, send input, stream terminal)
- Agent hot-join, clone/restart, AI summarization
- Server info and health

## Documentation

- [API Reference](docs/API.md) — All HTTP endpoints with curl examples
- [Architecture](docs/ARCHITECTURE.md) — System diagrams, data flows, state machine
- [Setup Guide](docs/SETUP.md) — Dev, production, Docker, env vars, MCP, troubleshooting

## License

[MIT](LICENSE)
