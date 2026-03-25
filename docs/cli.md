---
title: CLI Reference
nav_order: 5
---

# Agent-Forge — CLI Reference

## agent-forge CLI

```bash
# Run via tsx
npx tsx cli/agent-forge.ts <command>

# Or if linked
agent-forge <command>
```

### Commands

| Command | Description |
|---|---|
| `status` | Check server health |
| `teams` / `ls` | List all teams |
| `monitor [teamId]` | Open TUI monitor |
| `monitor --latest` | Monitor most recent team |
| `steer <teamId> "msg"` | Send steering message to team |
| `help` | Show help |

### Examples

```bash
# Check server
agent-forge status

# List active teams
agent-forge teams

# Watch the latest team
agent-forge monitor --latest

# Redirect a team's focus
agent-forge steer abc-123 "Stop the current approach and focus on testing"
```

---

## TUI Monitor

The terminal monitor (`cli/monitor.ts`) provides a real-time view of agent collaboration.

### Keybindings

| Key | Action |
|---|---|
| `s` | Steer entire team (opens input) |
| `1`-`4` | Steer specific agent by index |
| `j` / `k` or `↓` / `↑` | Scroll message history |
| `d` | Disband team |
| `q` | Quit monitor |
| `ESC` | Cancel input |

### Idle detection

After 60 seconds of no activity combined with completion signals, the monitor shows an action menu:

- Show summary
- Let team continue working
- Steer with new goal
- Disband team

---

## npm scripts

```bash
npm run dev       # Start server (development)
npm run start     # Start server (production)
npm run build     # TypeScript typecheck (no emit)
npm run lint      # ESLint
npm run monitor   # Open TUI monitor for latest team
npm run cli       # Run agent-forge CLI
```
