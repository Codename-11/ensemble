---
name: collab
description: Start a collaborative AI team (Codex + Claude) to work on a task together. Use when the user says "collab", "team research", "let Codex and Claude work together", or wants multiple AI agents to analyze, research, or solve something together autonomously.
allowed-tools: Bash, Read, Write, Agent, TaskOutput
metadata:
  author: michel
  version: 6.1.0
  platform: windows
---

# Collab: Autonomous AI Team Collaboration (Windows)

**Language rule:** ALWAYS respond in the same language the user used to invoke /collab. If the user writes in English, all your output (status updates, summaries, everything) must be in English. If Dutch, respond in Dutch. Never mix languages.

Launch a Codex + Claude team. Scripts live in `__ENSEMBLE_DIR__/scripts/`. Runtime files namespaced under `__RUNTIME_ROOT__/<TEAM_ID>/`.

## Path Convention
All collab artifacts live in `__RUNTIME_ROOT__/<TEAM_ID>/`:
- `messages.jsonl` — agent + ensemble message log
- `summary.txt` — written on disband by ensemble-service
- `bridge.pid`, `bridge.log` — bridge process
- `poller.pid`, `feed.txt` — background poller
- `prompts/`, `delivery/` — agent prompt/delivery files
- `.finished` — written by ensemble-service AFTER summary.txt
- `team-id` — team ID marker

## Workflow

### Step 1: Launch the team + open monitor

Run the cross-platform launcher. This starts the server (if needed), creates the team, starts the bridge, AND opens the monitor TUI in a new Windows Terminal tab automatically:
```bash
node "__ENSEMBLE_DIR__/scripts/collab-launch.mjs" "$(pwd)" "$TASK_DESCRIPTION"
```

Extract TEAM_ID:
```bash
TEAM_ID=$(cat "__RUNTIME_ROOT__/../collab-team-id.txt" 2>/dev/null || cat "$TEMP/collab-team-id.txt")
```

### Step 2: Tell the user about the monitor

The monitor TUI opens automatically in a new Windows Terminal tab. Tell the user:
- "The monitor TUI is live in a new tab — switch to it to see the conversation in real time."
- Keybindings: `s` steer team, `1-4` steer agent, `j/k` scroll, `d` disband, `q` quit.

If the user closed the monitor tab, they can reopen it:
```bash
cd "__ENSEMBLE_DIR__" && npx tsx cli/monitor.ts "$TEAM_ID"
```

### Step 3: Monitoring — the user MUST see the conversation

**CRITICAL RULE**: The user wants to SEE the team's conversation as it happens. Every poll result must be presented clearly and formatted as a readable conversation. Do NOT just dump raw output — format it as a proper dialogue.

#### Poll via API (recommended on Windows):

```bash
curl -s "http://localhost:23000/api/ensemble/teams/$TEAM_ID/feed" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{(JSON.parse(d).messages||[]).forEach(m=>console.log(m.from+': '+m.content))})"
```

Or read the messages file directly:
```bash
RUNTIME="__RUNTIME_ROOT__/$TEAM_ID"
tail -20 "$RUNTIME/messages.jsonl" 2>/dev/null | while IFS= read -r line; do
  echo "$line" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const m=JSON.parse(d);console.log(m.from+': '+m.content)}catch{}})"
done
```

**Presentation rules — THIS IS THE KEY PART:**
After each poll, present the new messages to the user like this:

> **codex-1**: [message content]
>
> **claude-2**: [message content]

Use markdown bold for agent names. Show the FULL message content (up to 500 chars), not truncated summaries. Between polls, add a brief status line like "Team is working... next check in 15s."

**Polling cadence:**
- First poll: 10s delay
- Normal: 15-20s
- If 3+ polls quiet: 30s (agents in deep work)
- When `.finished` marker exists: stop polling, present final summary

**When done**, present structured summary:
```bash
RUNTIME="__RUNTIME_ROOT__/$TEAM_ID"
cat "$RUNTIME/summary.txt" 2>/dev/null
```

### Step 4: Background completion watcher

Wait for the team to finish:
```bash
RUNTIME="__RUNTIME_ROOT__/$TEAM_ID"
while [ ! -f "$RUNTIME/.finished" ] && [ ! -f "$RUNTIME/summary.txt" ]; do sleep 8; done
echo "COLLAB_COMPLETE"
cat "$RUNTIME/summary.txt" 2>/dev/null
```
Run with `run_in_background: true`, `timeout: 600000`.

When done: summarize the results.

## Important Notes
- Agents run with auto-accept permissions (configured in agents.json: codex `--full-auto`, claude `--dangerously-skip-permissions`). They should NEVER ask for file write approval.
- Do not modify project code during a collab session unless the user explicitly asks
- Do not truncate or remove `messages.jsonl`
- Multiple collabs can run simultaneously — each has own `__RUNTIME_ROOT__/<TEAM_ID>/` namespace
- `team-say.mjs` uses mkdir-based file locking for atomic JSONL writes (cross-platform)
- `ensemble-bridge.mjs` has single-instance guard, health check, exponential backoff
- `.finished` and `summary.txt` are written by ensemble-service, NOT by scripts
- Bridge auto-stops when it sees `.finished` marker
- On Windows, sessions use node-pty instead of tmux — no tmux needed
