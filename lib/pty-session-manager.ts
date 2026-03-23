/**
 * PTY Session Manager — Cross-platform agent runtime using node-pty.
 *
 * Replaces TmuxRuntime on Windows (and optionally other platforms).
 * Each "session" is a node-pty pseudoterminal process. Output is buffered
 * in a per-session ring buffer so capturePane() can return recent output
 * without shelling out.
 */

import type { AgentRuntime, DiscoveredSession } from './agent-runtime'
import os from 'os'
import path from 'path'
import fs from 'fs'

// node-pty is an optional dependency — loaded dynamically so the module
// doesn't hard-fail on systems that haven't installed it.
let pty: typeof import('node-pty') | null = null
type IPty = import('node-pty').IPty

function loadPty(): typeof import('node-pty') {
  if (!pty) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      pty = require('node-pty')
    } catch {
      throw new Error(
        'node-pty is required for Windows session management. Run: npm install node-pty'
      )
    }
  }
  return pty!
}

// ---------------------------------------------------------------------------
// Output ring buffer — stores the last N lines of PTY output per session
// ---------------------------------------------------------------------------

const DEFAULT_BUFFER_LINES = 5000

class OutputBuffer {
  private lines: string[] = []
  private partial = '' // incomplete line (no trailing newline yet)
  private readonly maxLines: number

  constructor(maxLines = DEFAULT_BUFFER_LINES) {
    this.maxLines = maxLines
  }

  /** Append raw PTY output data */
  append(data: string): void {
    // PTY output comes in chunks that may split across line boundaries.
    // Combine with any leftover partial line from the previous chunk.
    const text = this.partial + data
    const parts = text.split(/\r?\n/)

    // Last element is either '' (if data ended with \n) or an incomplete line
    this.partial = parts.pop() ?? ''

    for (const line of parts) {
      this.lines.push(line)
    }

    // Trim to max
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(this.lines.length - this.maxLines)
    }
  }

  /** Return the last `n` lines as a single string */
  capture(n: number): string {
    const start = Math.max(0, this.lines.length - n)
    const result = this.lines.slice(start)
    // Include the partial line if it has content
    if (this.partial) {
      result.push(this.partial)
    }
    return result.join('\n')
  }

  /** Return total buffered line count */
  get lineCount(): number {
    return this.lines.length + (this.partial ? 1 : 0)
  }
}

// ---------------------------------------------------------------------------
// Session record
// ---------------------------------------------------------------------------

interface PtySession {
  pty: IPty
  name: string
  cwd: string
  output: OutputBuffer
  createdAt: Date
  env: Record<string, string>
}

// ---------------------------------------------------------------------------
// PtySessionManager
// ---------------------------------------------------------------------------

export class PtySessionManager implements AgentRuntime {
  readonly type: AgentRuntime['type'] = 'direct'

  private sessions = new Map<string, PtySession>()

  // -- Discovery -----------------------------------------------------------

  async listSessions(): Promise<DiscoveredSession[]> {
    const results: DiscoveredSession[] = []
    for (const [name, session] of this.sessions) {
      results.push({
        name,
        windows: 1,
        createdAt: session.createdAt.toISOString(),
        workingDirectory: session.cwd,
      })
    }
    return results
  }

  // -- Existence / status --------------------------------------------------

  async sessionExists(name: string): Promise<boolean> {
    return this.sessions.has(name)
  }

  async getWorkingDirectory(name: string): Promise<string> {
    const session = this.sessions.get(name)
    return session?.cwd ?? ''
  }

  async isInCopyMode(_name: string): Promise<boolean> {
    // PTY sessions don't have a copy mode concept
    return false
  }

  async cancelCopyMode(_name: string): Promise<void> {
    // No-op for PTY sessions
  }

  // -- Lifecycle -----------------------------------------------------------

  async createSession(name: string, cwd: string): Promise<void> {
    if (this.sessions.has(name)) {
      throw new Error(`Session "${name}" already exists`)
    }

    const nodePty = loadPty()
    const isWindows = os.platform() === 'win32'

    // Pick shell based on platform
    const shell = isWindows
      ? process.env.COMSPEC || 'cmd.exe'
      : process.env.SHELL || '/bin/bash'

    const shellArgs = isWindows ? [] : ['--login']

    const ptyProcess = nodePty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      } as Record<string, string>,
    })

    const output = new OutputBuffer()
    ptyProcess.onData((data: string) => {
      output.append(data)
    })

    this.sessions.set(name, {
      pty: ptyProcess,
      name,
      cwd,
      output,
      createdAt: new Date(),
      env: {},
    })
  }

  async killSession(name: string): Promise<void> {
    const session = this.sessions.get(name)
    if (!session) return

    try {
      session.pty.kill()
    } catch {
      // Process may already be dead
    }
    this.sessions.delete(name)
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    const session = this.sessions.get(oldName)
    if (!session) {
      throw new Error(`Session "${oldName}" not found`)
    }
    this.sessions.delete(oldName)
    session.name = newName
    this.sessions.set(newName, session)
  }

  // -- I/O -----------------------------------------------------------------

  async sendKeys(
    name: string,
    keys: string,
    opts: { literal?: boolean; enter?: boolean } = {}
  ): Promise<void> {
    const session = this.sessions.get(name)
    if (!session) {
      throw new Error(`Session "${name}" not found`)
    }

    const { literal = false, enter = false } = opts

    if (literal) {
      // Write text directly to the PTY
      session.pty.write(keys)
      if (enter) {
        session.pty.write('\r')
      }
    } else {
      // Interpret special key sequences (e.g., "C-c", "C-m", "Enter")
      const translated = this.translateKeySequence(keys)
      session.pty.write(translated)
      if (enter) {
        session.pty.write('\r')
      }
    }
  }

  async pasteFromFile(name: string, filePath: string): Promise<void> {
    const session = this.sessions.get(name)
    if (!session) {
      throw new Error(`Session "${name}" not found`)
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    session.pty.write(content)

    // Match TmuxRuntime behavior: delay then send Enter twice
    await new Promise(r => setTimeout(r, 1000))
    session.pty.write('\r')
    await new Promise(r => setTimeout(r, 300))
    session.pty.write('\r')
  }

  async capturePane(name: string, lines: number = 2000): Promise<string> {
    const session = this.sessions.get(name)
    if (!session) return ''

    const safeLine = Math.max(1, Math.min(10000, Math.floor(lines)))
    return session.output.capture(safeLine)
  }

  // -- Environment ---------------------------------------------------------

  async setEnvironment(name: string, key: string, value: string): Promise<void> {
    const session = this.sessions.get(name)
    if (!session) return

    session.env[key] = value
    // Set the env var in the running shell
    const isWindows = os.platform() === 'win32'
    if (isWindows) {
      session.pty.write(`set ${key}=${value}\r`)
    } else {
      session.pty.write(`export ${key}='${value.replace(/'/g, "'\\''")}'\r`)
    }
  }

  async unsetEnvironment(name: string, key: string): Promise<void> {
    const session = this.sessions.get(name)
    if (!session) return

    delete session.env[key]
    const isWindows = os.platform() === 'win32'
    if (isWindows) {
      session.pty.write(`set ${key}=\r`)
    } else {
      session.pty.write(`unset ${key}\r`)
    }
  }

  // -- PTY -----------------------------------------------------------------

  getAttachCommand(name: string, _socketPath?: string): { command: string; args: string[] } {
    // PTY sessions don't support external attach like tmux.
    // Return a no-op that just echoes the session name.
    return { command: 'echo', args: [`PTY session: ${name} (attach not supported)`] }
  }

  // -- Helpers -------------------------------------------------------------

  /** Translate tmux-style key sequences to terminal escape codes */
  private translateKeySequence(keys: string): string {
    const parts = keys.trim().split(/\s+/)
    let result = ''

    for (const part of parts) {
      switch (part) {
        case 'C-c':
          result += '\x03' // Ctrl+C
          break
        case 'C-d':
          result += '\x04' // Ctrl+D
          break
        case 'C-m':
        case 'Enter':
          result += '\r'   // Enter/Return
          break
        case 'C-a':
          result += '\x01'
          break
        case 'C-e':
          result += '\x05'
          break
        case 'C-l':
          result += '\x0c' // Ctrl+L (clear)
          break
        case 'C-z':
          result += '\x1a'
          break
        case 'Escape':
          result += '\x1b'
          break
        case 'Tab':
          result += '\t'
          break
        case 'Space':
          result += ' '
          break
        case 'BSpace':
          result += '\x7f' // Backspace
          break
        case 'Up':
          result += '\x1b[A'
          break
        case 'Down':
          result += '\x1b[B'
          break
        case 'Right':
          result += '\x1b[C'
          break
        case 'Left':
          result += '\x1b[D'
          break
        default:
          // Handle C-<letter> generically
          if (/^C-[a-z]$/.test(part)) {
            const charCode = part.charCodeAt(2) - 96 // 'a' = 1, 'b' = 2, etc.
            result += String.fromCharCode(charCode)
          } else {
            // Pass through as literal text (e.g., "q" for cancel copy mode)
            result += part
          }
      }
    }

    return result
  }

  /** Get a session (for testing or internal use) */
  getSession(name: string): PtySession | undefined {
    return this.sessions.get(name)
  }

  /** Clean up all sessions (for graceful shutdown) */
  destroyAll(): void {
    for (const [name] of this.sessions) {
      try {
        this.sessions.get(name)?.pty.kill()
      } catch { /* ignore */ }
    }
    this.sessions.clear()
  }
}
