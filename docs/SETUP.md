# Agent-Forge — Setup and Deployment Guide

## Quick Start

```bash
git clone <repo-url> && cd agent-forge
npm install
npm start
```

The server starts on `http://localhost:23000`. Open the web dashboard or use the CLI.

---

## Prerequisites

- **Node.js** 18+ (22 recommended)
- **npm** 9+
- **tmux** (Linux/macOS only) -- for agent session management
- **node-pty** (Windows only) -- installed as an optional dependency
- At least one AI coding agent installed: `claude`, `codex`, `gemini`, `aider`, or `opencode`

---

## Development Setup

### All Platforms

```bash
# Clone and install
git clone <repo-url>
cd agent-forge
npm install

# Run in development mode (server + web SPA with hot reload)
npm run dev

# Or run server and web separately
npm run dev:server    # Server on :23000
npm run dev:web       # Vite dev server on :5173
```

### Windows

Windows uses **node-pty** instead of tmux for terminal session management. The `node-pty` package is listed as an optional dependency and should install automatically. If it fails:

```bash
# node-pty requires build tools
npm install --global windows-build-tools   # or install Visual Studio Build Tools
npm install node-pty
```

No tmux installation is needed on Windows. The `PtySessionManager` (in `lib/pty-session-manager.ts`) handles all session operations natively.

### macOS

```bash
# Install tmux via Homebrew
brew install tmux

# Verify tmux is available
tmux -V

# Install and run
npm install
npm start
```

### Linux (Ubuntu/Debian)

```bash
# Install tmux
sudo apt-get update && sudo apt-get install -y tmux

# Verify
tmux -V

# Install and run
npm install
npm start
```

---

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npx vitest
```

Tests are written with Vitest and live in the `tests/` directory.

---

## Production Deployment

### Docker

The included `Dockerfile` builds the web SPA and runs the server:

```bash
# Build
docker build -t agent-forge .

# Run
docker run -d \
  --name agent-forge \
  -p 23000:23000 \
  -v agent-forge-data:/root/.agent-forge \
  agent-forge

# With custom configuration
docker run -d \
  --name agent-forge \
  -p 23000:23000 \
  -e AGENT_FORGE_PORT=23000 \
  -e AGENT_FORGE_HOST=0.0.0.0 \
  -e AGENT_FORGE_DATA_DIR=/data \
  -v agent-forge-data:/data \
  agent-forge
```

The Docker image includes tmux, curl, and Python 3 for full agent support on Linux.

**Important:** When deploying with Docker, you need the AI agent CLIs available inside the container. Mount them or install them in a custom Dockerfile layer:

```dockerfile
FROM agent-forge:latest
# Install your agent CLIs here
RUN npm install -g @anthropic/claude-code
RUN npm install -g @openai/codex
```

### Ubuntu Bare Metal

```bash
# Install system dependencies
sudo apt-get update
sudo apt-get install -y nodejs npm tmux git curl

# Install Node.js 22 (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and install
git clone <repo-url> /opt/agent-forge
cd /opt/agent-forge
npm install --production
cd web && npm install && npm run build && cd ..

# Create a systemd service
sudo tee /etc/systemd/system/agent-forge.service << EOF
[Unit]
Description=Agent-Forge Multi-Agent Server
After=network.target

[Service]
Type=simple
User=agent-forge
WorkingDirectory=/opt/agent-forge
ExecStart=/usr/bin/npx tsx server.ts
Environment=NODE_ENV=production
Environment=AGENT_FORGE_PORT=23000
Environment=AGENT_FORGE_HOST=0.0.0.0
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable agent-forge
sudo systemctl start agent-forge

# Check status
sudo systemctl status agent-forge
curl http://localhost:23000/api/v1/health
```

---

## Configuration

### Environment Variables

| Variable                        | Default                     | Description                                         |
|---------------------------------|-----------------------------|-----------------------------------------------------|
| `AGENT_FORGE_PORT`                 | `23000`                     | HTTP server port                                    |
| `AGENT_FORGE_HOST`                 | `127.0.0.1`                 | HTTP server bind address                            |
| `AGENT_FORGE_DATA_DIR`             | `~/.agent-forge`               | Durable data directory (teams, messages)            |
| `AGENT_FORGE_RUNTIME_DIR`          | `<os.tmpdir()>/agent-forge`    | Ephemeral runtime directory (prompts, delivery)     |
| `AGENT_FORGE_URL`                  | `http://localhost:23000`    | API URL used by CLI, bridge, and launch scripts     |
| `AGENT_FORGE_CORS_ORIGIN`          | *(localhost patterns)*      | Comma-separated allowed CORS origins                |
| `AGENT_FORGE_AGENTS_CONFIG`        | `./agents.json`             | Path to agent definitions file                      |
| `AGENT_FORGE_HOST_ID`              | *(auto-detected hostname)*  | This machine's host ID for multi-host setups        |
| `AGENT_FORGE_CREATED_BY`           | `$USER`                     | Default "created by" field for new teams            |
| `AGENT_FORGE_WATCHDOG_NUDGE_MS`    | `180000` (3 min)            | Idle time before watchdog nudges an agent           |
| `AGENT_FORGE_WATCHDOG_STALL_MS`    | `300000` (5 min)            | Idle time before marking agent as stalled           |
| `AGENT_FORGE_TELEGRAM_BOT_TOKEN`   | *(disabled)*                | Telegram bot token for disband notifications        |
| `AGENT_FORGE_TELEGRAM_CHAT_ID`     | *(disabled)*                | Telegram chat ID for disband notifications          |

Legacy aliases:
- `ORCHESTRA_PORT` is accepted as a fallback for `AGENT_FORGE_PORT`

---

## Agent Setup

### How `agents.json` Works

The `agents.json` file in the project root defines all supported AI coding agents. Each entry specifies how to launch and communicate with the agent:

```json
{
  "codex": {
    "name": "codex",
    "command": "codex",
    "flags": ["--full-auto"],
    "readyMarker": "\u203a",
    "inputMethod": "pasteFromFile",
    "color": "blue",
    "icon": "\u25c6",
    "mcpMode": "config-flag"
  },
  "claude": {
    "name": "claude",
    "command": "claude",
    "flags": ["--dangerously-skip-permissions"],
    "readyMarker": "\u276f",
    "inputMethod": "sendKeys",
    "color": "green",
    "icon": "\u25cf",
    "mcpMode": "config-file",
    "mcpConfigFlag": "--mcp-config"
  }
}
```

**Field reference:**

| Field           | Description                                                                  |
|-----------------|------------------------------------------------------------------------------|
| `name`          | Display name                                                                 |
| `command`       | CLI command to run (must be in PATH)                                         |
| `flags`         | Command-line flags passed on launch                                          |
| `readyMarker`   | String to look for in terminal output to detect the agent is ready for input |
| `inputMethod`   | How to send prompts: `"sendKeys"` (keystroke injection) or `"pasteFromFile"` (tmux paste buffer) |
| `color`         | Display color for the web UI and TUI                                         |
| `icon`          | Unicode icon character                                                       |
| `mcpMode`       | How MCP is configured: `"config-flag"` (CLI flag) or `"config-file"` (JSON file) |
| `mcpConfigFlag` | The CLI flag name for MCP config (e.g. `"--mcp-config"`)                     |

### Adding a New Agent

1. Install the agent CLI so it is available on `PATH`

2. Add an entry to `agents.json`:

   ```json
   {
     "my-agent": {
       "name": "my-agent",
       "command": "my-agent-cli",
       "flags": ["--auto"],
       "readyMarker": ">",
       "inputMethod": "sendKeys",
       "color": "red",
       "icon": "\u25b6"
     }
   }
   ```

3. Test that it works:

   ```bash
   # Start the server
   npm start

   # Create a test team
   curl -X POST http://localhost:23000/api/agent-forge/teams \
     -H "Content-Type: application/json" \
     -d '{
       "name": "test",
       "description": "Say hello",
       "agents": [
         { "program": "my-agent" },
         { "program": "claude" }
       ]
     }'
   ```

4. Watch the monitor to verify the agent starts and receives its prompt:

   ```bash
   npm run monitor
   ```

### Choosing `inputMethod`

- **`sendKeys`** -- types text character-by-character into the terminal. Works for most CLIs but can break on special characters (`?`, `!`, `\`) in some shells (zsh).
- **`pasteFromFile`** -- writes text to a temp file, loads it into a tmux paste buffer, and pastes it in. More reliable for TUI apps that intercept keyboard input (like Codex and Gemini CLI). Sends Enter after pasting.

### Custom agents.json Location

Set `AGENT_FORGE_AGENTS_CONFIG` to point to a custom file:

```bash
AGENT_FORGE_AGENTS_CONFIG=/path/to/my-agents.json npm start
```

---

## MCP Integration

### How It Works

When agent-forge spawns an agent, it automatically configures MCP (Model Context Protocol) tools so the agent can communicate with teammates without shell commands:

1. **Config generation** -- The spawner writes a JSON MCP config file per agent at `<runtime-dir>/<teamId>/<agentName>-mcp.json`
2. **Config injection** -- The config is passed to the agent CLI via the appropriate mechanism:
   - `config-flag` agents (Codex): MCP server URL is passed as a CLI flag
   - `config-file` agents (Claude): a `--mcp-config` flag points to the JSON file
3. **Runtime** -- The MCP server (`mcp/agent-forge-mcp-server.mjs`) runs as a stdio child process of the agent, handling `team_say`, `team_read`, and `team_status` tool calls

### MCP Config File Format

The auto-generated config follows the standard MCP format:

```json
{
  "mcpServers": {
    "agent-forge": {
      "command": "node",
      "args": ["/path/to/agent-forge/mcp/agent-forge-mcp-server.mjs"],
      "env": {
        "AGENT_FORGE_TEAM_ID": "abc-123",
        "AGENT_FORGE_AGENT_NAME": "claude-1",
        "AGENT_FORGE_API_URL": "http://localhost:23000"
      }
    }
  }
}
```

### Testing MCP Manually

You can test the MCP server directly via stdin/stdout:

```bash
# Set required env vars
export AGENT_FORGE_TEAM_ID=test-team
export AGENT_FORGE_AGENT_NAME=test-agent
export AGENT_FORGE_API_URL=http://localhost:23000

# Start the MCP server
node mcp/agent-forge-mcp-server.mjs

# Send an initialize request (paste this as a single line):
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}

# List available tools:
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}

# Call team_status:
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"team_status","arguments":{}}}
```

Logs go to stderr, JSON-RPC responses go to stdout.

### Installing as a Claude Code Skill

The setup script installs agent-forge as a `/collab` skill in Claude Code:

```bash
npm run setup
# or
node scripts/setup-claude-code.mjs
```

This copies the skill definition to `~/.claude/skills/collab/` and updates Claude Code settings to recognize the `/collab` command.

---

## Collaboration Templates

Four built-in templates are defined in `collab-templates.json`:

| Template     | Roles                      | Best For                              |
|--------------|----------------------------|---------------------------------------|
| `review`     | REVIEWER, CRITIC           | Code review and analysis              |
| `implement`  | ARCHITECT, DEVELOPER       | Building new features                 |
| `research`   | RESEARCHER-A, RESEARCHER-B | Exploring topics from two angles      |
| `debug`      | REPRODUCER, ANALYST        | Bug investigation and fixing          |

Each template defines role-specific focus areas that are injected into agent prompts. When no template is specified, agents default to LEAD/WORKER roles.

---

## Telegram Notifications

To receive a summary message on Telegram when a team disbands:

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather)
2. Get your chat ID (message the bot, then check `https://api.telegram.org/bot<TOKEN>/getUpdates`)
3. Set environment variables:

```bash
export AGENT_FORGE_TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
export AGENT_FORGE_TELEGRAM_CHAT_ID="987654321"
npm start
```

Notifications include: task description, duration, message count, and per-agent message/token stats.

---

## Multi-Host Setup

To distribute agents across multiple machines:

1. Run the agent-forge server on each machine
2. Create `~/.agent-forge/hosts.json`:

   ```json
   {
     "hosts": [
       {
         "id": "laptop",
         "name": "My Laptop",
         "url": "http://192.168.1.10:23000",
         "enabled": true
       },
       {
         "id": "desktop",
         "name": "My Desktop",
         "url": "http://192.168.1.20:23000",
         "enabled": true
       }
     ]
   }
   ```

3. When creating a team, specify `hostId` per agent:

   ```bash
   curl -X POST http://localhost:23000/api/agent-forge/teams \
     -H "Content-Type: application/json" \
     -d '{
       "name": "distributed-review",
       "description": "Review the codebase",
       "agents": [
         { "program": "claude", "hostId": "laptop" },
         { "program": "codex", "hostId": "desktop" }
       ]
     }'
   ```

Each host must have the respective agent CLIs installed locally. The orchestrating server coordinates spawning and message routing across hosts.

---

## Troubleshooting

### Server won't start: "Port 23000 is already in use"

Another process is using the port. Either stop it or use a different port:

```bash
AGENT_FORGE_PORT=23001 npm start
```

### Agent fails to spawn

Check that the agent CLI is installed and in PATH:

```bash
which claude    # or: which codex, which gemini
```

### Agent never becomes "ready"

The `readyMarker` in `agents.json` may not match what the agent actually prints. Check the terminal output:

```bash
curl "http://localhost:23000/api/agent-forge/sessions/<session-name>/output?lines=50"
```

Compare with the `readyMarker` value and adjust if needed.

### Messages not being delivered

1. Check that the agent-forge server is running: `curl http://localhost:23000/api/v1/health`
2. Check that agent sessions exist: `curl http://localhost:23000/api/agent-forge/sessions`
3. Check team status: `curl http://localhost:23000/api/agent-forge/teams/<id>`

### Windows: "node-pty is required"

Install node-pty:

```bash
npm install node-pty
```

If it fails, ensure you have C++ build tools installed (Visual Studio Build Tools or `windows-build-tools`).

### tmux errors on macOS/Linux

Ensure tmux is installed and the server process has access to the tmux socket:

```bash
tmux -V          # Should print version
tmux list-sessions  # Should not error
```
