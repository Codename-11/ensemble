/**
 * AgentProgram — Declarative configuration for AI agent programs.
 * Loaded from agents.json at runtime; eliminates hardcoded agent-specific logic.
 */

export interface AgentProgram {
  /** Unique identifier matching the key in agents.json (e.g. "codex", "claude") */
  name: string
  /** CLI command to launch the agent (e.g. "codex", "claude", "aider") */
  command: string
  /** Default flags appended to the command (e.g. ["-m", "gpt-5.4"]) */
  flags: string[]
  /** String that appears in tmux pane when agent is ready for input */
  readyMarker: string
  /** How to deliver multi-line prompts */
  inputMethod: 'pasteFromFile' | 'sendKeys'
  /** Base color name for monitor TUI (e.g. "blue", "green", "magenta", "yellow") */
  color: string
  /** Single-char icon shown in monitor UI (e.g. "◆", "●", "▲", "★") */
  icon: string
  /** How to pass MCP config to this agent at launch.
   *  - "config-file": pass --mcp-config <path> (Claude Code)
   *  - "config-flag": pass -c key=value overrides (Codex)
   *  - undefined: agent doesn't support MCP */
  mcpConfigFlag?: string
  mcpMode?: 'config-file' | 'config-flag'
}

export interface AgentsConfig {
  [key: string]: AgentProgram
}
