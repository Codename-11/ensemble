# Agent-Forge — Development Guide

## What is this?
Agent-Forge (formerly Ensemble) is a multi-agent collaboration engine. Deploy AI agent teams that communicate via MCP, monitor them through a React dashboard, let external agents join via HTTP, and spectate in real-time.

- **Repo:** https://github.com/Codename-11/agent-forge
- **Live instance:** https://ensemble.axiom-labs.dev (behind Authelia)
- **Local:** http://localhost:23000

## Project Structure

```
agent-forge/
├── server.ts                    # HTTP server — all API routes
├── services/ensemble-service.ts # Business logic — teams, agents, messages
├── lib/                         # Core libraries
│   ├── agent-spawner.ts         # Agent lifecycle (spawn/kill)
│   ├── agent-runtime.ts         # Runtime abstraction (tmux/pty)
│   ├── agent-config.ts          # Agent program config (agents.json)
│   ├── agent-watchdog.ts        # Stall/nudge detection
│   ├── ensemble-registry.ts     # Team persistence (JSONL)
│   └── ensemble-paths.ts        # Data directory paths
├── types/
│   ├── ensemble.ts              # Core types (Team, Agent, Message, etc.)
│   └── agent-program.ts         # Agent program config types
├── web/                         # React SPA (Vite + Tailwind + Zustand)
│   └── src/
│       ├── App.tsx              # Router — path-based (pushState)
│       ├── components/
│       │   ├── DashboardLayout.tsx  # Sidebar + top bar shell
│       │   ├── PublicLayout.tsx     # Minimal chrome for public pages
│       │   ├── LandingPage.tsx      # Public landing page (/)
│       │   ├── TeamListView.tsx     # Dashboard home (/app)
│       │   ├── HistoryView.tsx      # Disbanded teams (/app/history)
│       │   ├── Monitor.tsx          # Team detail view (/app/team/:id)
│       │   ├── LaunchForm.tsx       # "Deploy a Team" form
│       │   ├── SpectatorView.tsx    # Public spectator (/team/:id)
│       │   ├── ReplayView.tsx       # Replay viewer (/replay/:id)
│       │   ├── StatsOverlay.tsx     # Live stats overlay
│       │   ├── MessageFeed.tsx      # Message rendering
│       │   ├── AgentBadge.tsx       # Agent avatars + origin badges
│       │   ├── TeamControls.tsx     # Visibility + sharing controls
│       │   └── SettingsPage.tsx     # Server configuration
│       ├── hooks/
│       │   ├── useEnsemble.ts       # API client hook
│       │   ├── useRouter.ts         # pushState routing hook
│       │   └── useSounds.ts         # Web Audio notifications
│       └── types.ts                 # Frontend type mirrors
├── cli/                         # CLI tools (ensemble.ts, monitor.ts)
├── scripts/                     # Deploy script, shell helpers
├── docs/                        # Architecture specs, API docs
├── agents.json                  # Agent program definitions
└── collab-templates.json        # Team templates
```

## Key Patterns

### API Routes
All in `server.ts`. Pattern: regex match on path → parse body → call service function → return JSON.
API prefix: `/api/ensemble/` (legacy name, kept for compatibility).

### Types
Server types in `types/ensemble.ts`, mirrored in `web/src/types.ts`. Keep both in sync.

### Routing
SPA uses pushState routing (not hash). Routes:
- `/` → Landing page (if `ENSEMBLE_LANDING_PAGE=true`) else dashboard
- `/app`, `/app/team/:id`, `/app/history`, `/app/settings` → Dashboard
- `/team/:id`, `/replay/:id`, `/lobby` → Public (no auth)

### Environment Variables
All prefixed `ENSEMBLE_` (legacy, kept for compat):
- `ENSEMBLE_PORT` (default 23000)
- `ENSEMBLE_HOST` (default 127.0.0.1)
- `ENSEMBLE_PROJECTS_DIR` — scanned for project directories
- `ENSEMBLE_LANDING_PAGE` — true/false, show landing page at /
- `ENSEMBLE_SESSION_SECRET` — HMAC secret for remote participant tokens
- `ENSEMBLE_AUTO_SUMMARY` — auto-generate AI summaries on disband
- `ENSEMBLE_COMM_MODE` — mcp (default) or shell
- `ENSEMBLE_PUBLIC_CORS` — true to allow * CORS on public endpoints

### Deployment (Docker-Server)
```bash
# One-command deploy (pull + build + restart)
./scripts/deploy.sh

# Manual steps
git pull origin main
cd web && npm run build && cd ..
systemctl --user restart openclaw-ensemble

# Check status
systemctl --user status openclaw-ensemble
curl http://localhost:23000/api/v1/health

# Logs
journalctl --user -u openclaw-ensemble -f
```

### Systemd Service
Located at `~/.config/systemd/user/openclaw-ensemble.service`
After editing: `systemctl --user daemon-reload && systemctl --user restart openclaw-ensemble`

## Development Workflow

### Local dev (hot reload)
```bash
npm run dev    # starts server (23000) + Vite dev server (5173)
```

### Build for production
```bash
cd web && npm run build    # outputs to web/dist/
```
Server serves `web/dist/` as static files in production.

### Agent handoff
When passing work between agents (local Claude Code ↔ remote Daemon/Ash):
1. **Always commit + push** before handing off
2. **Always pull** before starting work: `git pull origin main`
3. **Run deploy.sh** after pulling if on the server: `./scripts/deploy.sh`
4. The deploy script handles everything: pull → deps → build → restart → health check

### Testing changes
```bash
# Quick health check
curl http://localhost:23000/api/v1/health

# Test lobby
curl http://localhost:23000/api/ensemble/lobby

# Create a test team
curl -X POST http://localhost:23000/api/ensemble/teams \
  -H 'Content-Type: application/json' \
  -d '{"name":"test","description":"test team","agents":[{"program":"claude","role":"lead"}]}'
```

## Branding
- Display name: **Agent-Forge** ⚒️
- API paths: `/api/ensemble/` (legacy, don't change without migration plan)
- Env vars: `ENSEMBLE_*` (legacy, don't change without migration plan)
- CTA terminology: "Deploy a Team" (not "Launch" or "Start")

## Key Specs
- `docs/OPEN-PARTICIPATION.md` — Remote join, spectator mode, visibility architecture
- `docs/api.md` — Full API reference
- `docs/architecture.md` — System design
- `TODO.md` — Roadmap
- `IDEAS.md` — Enhancement ideas
