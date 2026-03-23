# Ensemble — TODO & Roadmap

## P0 — Release Blockers

| # | Issue | Location | Status |
|---|-------|----------|--------|
| 1 | No LICENSE file | repo root | ⬜ Open |
| 2 | No CI/CD (.github/workflows/) | repo root | ⬜ Open |
| 3 | Open CORS * + 0.0.0.0 binding in production | server.ts | ⬜ Open |
| 4 | No auth on API (needed for remote agent join) | server.ts | ⬜ Open |
| 5 | Remote permission mode bypass — `spawnRemoteAgent` doesn't forward `permissionMode` | lib/agent-spawner.ts | ⬜ Open |
| 6 | Windows Codex quoting — `cmd.exe` ignores single quotes in `-c` flags | lib/agent-spawner.ts:70-71 | ⬜ Open |
| 7 | `strict: false` in tsconfig | tsconfig.json | ⬜ Open |

## P1 — Planned Features

### P1 #1: Open Participation Model (absorbs AgentMeet concept) — ⏳ Spec Complete (Spec: docs/OPEN-PARTICIPATION.md)

> **Architecture spec:** [docs/OPEN-PARTICIPATION.md](docs/OPEN-PARTICIPATION.md)

**Implementation phases (see spec §9 for full breakdown):**

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Type additions (`TeamVisibility`, `RemoteParticipant`, etc.) + migration defaults | ⬜ Open |
| 2 | `PATCH /teams/:id` (visibility), `POST /teams/:id/share` | ⬜ Open |
| 3 | `POST /teams/:id/join`, `POST /teams/:id/messages`, `POST /teams/:id/leave` | ⬜ Open |
| 4 | `GET /teams/:id/spectate` (SSE spectator stream) | ⬜ Open |
| 5 | `GET /lobby` endpoint | ⬜ Open |
| 6 | `VisibilityControls.tsx` + `ParticipantList.tsx` in existing UI | ⬜ Open |
| 7 | `SpectatorView.tsx` with SSE connection | ⬜ Open |
| 8 | `LandingPage.tsx` — hero, lobby, how-it-works, code snippets | ⬜ Open |
| 9 | Client-side routing (`/team/:id`, `/`) | ⬜ Open |
| 10 | Human join flow ("Join as Human" upgrade from spectator) | ⬜ Open |
| 11 | Security hardening (rate limits, idle cleanup, max connections) | ⬜ Open |

**Key capabilities:**
- Zero-signup spectating via shared links
- 3-line HTTP join for agents (Python/curl)
- Human steering via browser — click link → watch → optionally join
- Landing page with live lobby of public teams
- Flip visibility mid-session (private → shared → public) without restart
- Persistent session lifecycle (opt-in)
- HMAC session tokens, rate limiting, participant caps

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 2 | **Discord/OpenClaw Bridge** | Relay Discord messages ↔ ensemble API. Let OpenClaw and other Discord bots join collabs as agents. Works with the open participation model — OpenClaw agents can join public Ensemble teams as remote participants. | ⬜ Open |
| 3 | **Agent SDK npm package** | Thin npm/Python package wrapping the HTTP API. Makes it trivial for any agent to join a collab. | ⬜ Open |
| 4 | **Test coverage** | Zero tests for: `buildPermissionFlags`, remote spawn, `writeMcpConfig`, MCP tools, plan detection, `team_done`/`team_ask` flow. | ⬜ Open |
| 5 | **Settings page subtext** | Add descriptive help text for every settings field (what, when, why, impact). | ⬜ Open |
| 6 | **"Sessions" → "Team Sessions"** | UI terminology refinement throughout. | ⬜ Open |
| 7 | **Ralph Loops / Iterative Agent Runner** | Native loop runner for long-running iterative tasks. Instead of a single agent session that degrades with context rot, Ensemble re-invokes agents with fresh context each iteration. The spec file (team description or SPEC.md) is the source of truth. Each iteration: agent reads spec → checks plan progress → does next chunk → signals iteration complete. Ensemble records what was done, updates plan step status, and re-invokes with clean context + progress summary. Exit condition: all plan steps done, or agent calls `team_done`, or max iterations reached.<br><br>**Key capabilities:**<br>- Fresh context per iteration (fights context rot in long sessions)<br>- Spec file as persistent source of truth across iterations<br>- Plan tab tracks progress across iterations automatically<br>- Configurable max iterations + iteration timeout<br>- Iteration history viewable in message feed<br>- Works with both local and remote agents<br>- Can run overnight autonomously with safeguards | ⬜ Open |

## Known Issues / Technical Debt

| # | Issue | Status |
|---|-------|--------|
| 1 | JSONL persistence without file locking — race conditions with multi-process | ⬜ Open |
| 2 | `execAsync` with string interpolation — command injection risk in agent-runtime | ⬜ Open |
| 3 | Code duplication — `apiGet`/`apiPost` in multiple files | ✅ Fixed (EnsembleClient) |
| 4 | No CONTRIBUTING.md | ⬜ Open |
| 5 | No .gitignore for generated/temp files | ⬜ Open |
| 6 | `buildPermissionFlags` fail-open default — returns empty string for unknown modes | ⬜ Open |
| 7 | Dead code in summary generation (server.ts promptFile write) | ✅ Fixed |
| 8 | DEP0190 deprecation warnings from `shell: true` on Node 24 | ⬜ Open |

## P2 — Nice-to-haves

| # | Feature |
|---|---------|
| 1 | API docs (OpenAPI/Swagger) |
| 2 | Plugin/extensibility system for custom agent programs |
| 3 | Persistent storage beyond JSONL (SQLite) |
| 4 | Structured logging (not console.log) |
| 5 | Observability/tracing for agent interactions |
| 6 | Workflow graphs / DAG support for multi-step tasks |
| 7 | Checkpointing / state machines (LangGraph-style) |
| 8 | Shared context variables between agents (Swarm-style) |
| 9 | **Loop UI controls** — Start/pause/resume/kill loops from the web UI. Show iteration count, elapsed time, progress percentage, per-iteration summaries. |

## Recently Shipped ✅

### This session (2026-03-23)
- Windows support (PtySessionManager, cross-platform .mjs scripts)
- React SPA (Tailwind 4 + Zustand + Lucide + xterm.js)
- MCP communication (7 tools: team_say, team_read, team_done, team_plan, team_ask, team_status)
- WebSocket PTY terminal streaming (replaced flickery SSE polling)
- Smart agent naming (Claude not Claude-1, Lead badge, roles)
- Plan detection + Plan tab with interactive checklist
- Execution chain (Export prompt, Execute plan, Copy JSON)
- Permission modes (full, plan-only, review, execute)
- Control surfaces (maxTurns, timeout, nudge, stall per team)
- Non-blocking team creation, hot-join, clone/restart, reopen
- Completion confirmation banner + agent question banners
- AI summary (auto on disband + manual generate)
- Settings page (server config, watchdog, agents, MCP, system prompt, about)
- Session naming with readable auto-names
- MCP install/uninstall helpers + join-from-CLI
- Projects directory scanning (ENSEMBLE_PROJECTS_DIR)
- SKILL.md for agent knowledge
- Docker + docker-compose + Ubuntu install script
- Comprehensive docs (API.md, ARCHITECTURE.md, SETUP.md)

## Architecture Notes

**Positive:**
- Clean separation: types/ lib/ services/ cli/ scripts/ web/
- AgentRuntime abstraction (TmuxRuntime / PtySessionManager)
- MCP-based agent communication (~100ms vs 3-5s shell)
- EnsembleClient data layer shared between TUI and SPA

**Feature Gaps vs Competitors (CrewAI/AutoGen/LangGraph/Swarm):**
- No built-in tool/function calling framework
- No memory/context sharing between agents
- No workflow graphs or DAG support
- No observability/tracing
- No structured agent-to-agent protocol beyond MCP + REST

## Decided

- **Repo name:** `ensemble`
- **License:** MIT (TBD — file not created yet)
- **Position as:** "experimental developer tool", not "production framework"
- **Primary UI:** React SPA (TUI kept as fallback)
- **Communication:** MCP default, shell fallback (`ENSEMBLE_COMM_MODE`)
