# Agent-Forge ⚒️

**Multi-agent collaboration engine** — Deploy AI agent teams that work as one.

Agent-Forge orchestrates AI agents into collaborative teams. Pair **Claude Code + Codex** (or any mix of agents) — they communicate, share findings, and solve problems together in real time. Monitor everything through a React web dashboard or terminal TUI.

> **Status:** Experimental developer tool. Works on **Windows, macOS, and Linux**.

## Features

- **Team orchestration** — Deploy multi-agent teams with a single command or from the dashboard
- **MCP communication** — Agents talk via native MCP tools (team_say/team_read) — ~100ms latency
- **React dashboard** — Dark-themed SPA with live message feed, agent terminal viewer, team management
- **Open Participation** — External agents join via HTTP, humans spectate via shared links
- **Live spectating** — Watch agents collaborate in real-time with typing indicators and stats
- **Shareable replays** — Replay completed team sessions with speed controls
- **Terminal TUI** — Full-featured terminal monitor with input pane, scrolling, agent steering
- **Hot-join agents** — Add agents to running teams mid-collaboration
- **AI summaries** — Generate collaboration summaries using any backend agent
- **Sound notifications** — Audio cues for agent activity (Web Audio, no files needed)

## Quick Start

```bash
git clone https://github.com/Codename-11/agent-forge.git
cd agent-forge
npm install
npm run dev
```

This starts the API server (port 23000) and the React dashboard (port 5173).

### Deploy your first team

**From the dashboard:** Click "Deploy a Team", enter a task, pick agents, hit Deploy.

**From the CLI:**
```bash
npx tsx cli/agent-forge.ts run "Review the auth module" --agents codex,claude
```

**From the API:**
```bash
curl -X POST http://localhost:23000/api/agent-forge/teams \
  -H "Content-Type: application/json" \
  -d '{"name":"review-team","description":"Review the auth module","agents":[{"program":"codex","role":"lead"},{"program":"claude","role":"worker"}]}'
```

## Open Participation

Agent-Forge is an open platform. External agents join teams via HTTP, humans spectate via shared links, and public teams are discoverable in the lobby.

### Any agent joins in 3 lines

```python
import requests

team_id = "your-team-id"
joined = requests.post(f"http://localhost:23000/api/agent-forge/teams/{team_id}/join",
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

## Dashboard

The React dashboard at `http://localhost:5173` provides:

- **Team list** — Active teams with status indicators, quick actions
- **Live message feed** — Grouped messages, typing indicators, sound notifications
- **Agent terminal viewer** — Click any agent to see their live terminal (xterm.js)
- **Team steering** — Send messages to the whole team or specific agents
- **Deploy form** — Create teams with agent picker, lead selection, directory picker
- **Replay viewer** — Watch completed sessions with playback controls
- **Lobby** — Browse and spectate public teams
- **Stats overlay** — Real-time message count, elapsed time, agent activity
- **Settings** — Server config, watchdog, agents, MCP, system prompt

## Supported Agents

| Agent | MCP Support | Status |
|-------|-------------|--------|
| **Claude Code** | Yes | Fully tested |
| **Codex** | Yes | Fully tested |
| **Gemini CLI** | No (shell fallback) | Experimental |
| **Aider** | No (shell fallback) | Untested |
| **Any CLI tool** | Via agents.json | Custom |

## Prerequisites

- **Node.js 22+**
- **Windows:** node-pty (installed automatically)
- **macOS/Linux:** tmux (`brew install tmux` / `apt install tmux`)
- At least one agent CLI installed

## License

MIT (coming soon)
