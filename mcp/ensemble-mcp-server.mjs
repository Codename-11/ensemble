#!/usr/bin/env node
/**
 * agent-forge-mcp-server.mjs — MCP stdio server for team communication
 *
 * Exposes team_say, team_read, and team_status as native MCP tools,
 * replacing the slower shell-command-based approach.
 *
 * Environment variables:
 *   ENSEMBLE_TEAM_ID    — team this agent belongs to (required)
 *   ENSEMBLE_AGENT_NAME — this agent's display name (required)
 *   ENSEMBLE_API_URL    — API base URL (default: http://localhost:23000)
 *
 * Usage:
 *   node mcp/ensemble-mcp-server.mjs
 */

import http from 'http'
import { createInterface } from 'readline'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TEAM_ID = process.env.ENSEMBLE_TEAM_ID || ''
const AGENT_NAME = process.env.ENSEMBLE_AGENT_NAME || ''
const API_URL = (process.env.ENSEMBLE_API_URL || 'http://localhost:23000').replace(/\/+$/, '')

const SERVER_INFO = { name: 'agent-forge', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

// ---------------------------------------------------------------------------
// Logging (always to stderr — stdout is the MCP transport)
// ---------------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[agent-forge-mcp] ${args.join(' ')}\n`)
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'team_say',
    description: 'Send a message to your team or a specific teammate',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send' },
        to: {
          type: 'string',
          description: "Recipient: 'team' or a specific agent name",
          default: 'team',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'team_read',
    description: 'Read recent messages from your team conversation',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of recent messages to read',
          default: 10,
        },
      },
    },
  },
  {
    name: 'team_status',
    description: 'Check the current team status and which agents are active',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'team_done',
    description: 'Signal that you have completed your work. Call this when your task is finished instead of saying "standing by" or "waiting". This helps the team auto-disband cleanly.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief summary of what you accomplished' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'team_plan',
    description: 'Share a structured plan with numbered steps. The system will track these steps and show them in the Plan tab.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered list of plan steps',
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'team_ask',
    description: 'Ask the user a question. The question will appear as a banner in the web UI and the user can reply. Use this when you need clarification or a decision from the user. The response will appear as a team message.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
      },
      required: ['question'],
    },
  },
]

// ---------------------------------------------------------------------------
// HTTP helpers (Node built-in http — zero dependencies)
// ---------------------------------------------------------------------------

/**
 * Make an HTTP GET request and return the parsed JSON body.
 */
function apiGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_URL + path)
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: 10_000,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) })
          } catch {
            resolve({ status: res.statusCode, body: data })
          }
        })
      },
    )
    req.on('error', (err) => reject(err))
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })
    req.end()
  })
}

/**
 * Make an HTTP POST request with a JSON body and return the parsed response.
 */
function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const url = new URL(API_URL + path)
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'application/json',
        },
        timeout: 10_000,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) })
          } catch {
            resolve({ status: res.statusCode, body: data })
          }
        })
      },
    )
    req.on('error', (err) => reject(err))
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })
    req.write(payload)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleTeamSay(args) {
  const message = args.message
  const to = args.to || 'team'

  if (!message) {
    return toolError('Missing required argument: message')
  }
  if (!TEAM_ID) {
    return toolError('ENSEMBLE_TEAM_ID environment variable is not set')
  }
  if (!AGENT_NAME) {
    return toolError('ENSEMBLE_AGENT_NAME environment variable is not set')
  }

  try {
    const result = await apiPost(`/api/ensemble/teams/${TEAM_ID}`, {
      from: AGENT_NAME,
      to,
      content: message,
      id: randomUUID(),
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    })

    if (result.status >= 400) {
      const errMsg = result.body?.error || `HTTP ${result.status}`
      return toolError(`Failed to send message: ${errMsg}`)
    }

    return toolResult(`Message sent to ${to}`)
  } catch (err) {
    return toolError(`Cannot reach Agent-Forge API at ${API_URL}: ${err.message}`)
  }
}

async function handleTeamRead(args) {
  const count = args.count || 10

  if (!TEAM_ID) {
    return toolError('ENSEMBLE_TEAM_ID environment variable is not set')
  }

  try {
    const result = await apiGet(`/api/ensemble/teams/${TEAM_ID}/feed`)

    if (result.status >= 400) {
      const errMsg = result.body?.error || `HTTP ${result.status}`
      return toolError(`Failed to read messages: ${errMsg}`)
    }

    const messages = result.body?.messages || []
    const recent = messages.slice(-count)

    if (recent.length === 0) {
      return toolResult('No messages yet.')
    }

    const formatted = recent
      .map((m) => `[${m.timestamp || ''}] ${m.from} -> ${m.to}: ${m.content}`)
      .join('\n')

    return toolResult(formatted)
  } catch (err) {
    return toolError(`Cannot reach Agent-Forge API at ${API_URL}: ${err.message}`)
  }
}

async function handleTeamStatus(_args) {
  if (!TEAM_ID) {
    return toolError('ENSEMBLE_TEAM_ID environment variable is not set')
  }

  try {
    const result = await apiGet(`/api/ensemble/teams/${TEAM_ID}`)

    if (result.status >= 400) {
      const errMsg = result.body?.error || `HTTP ${result.status}`
      return toolError(`Failed to get team status: ${errMsg}`)
    }

    const team = result.body
    const lines = []
    lines.push(`Team: ${team.name || team.id || TEAM_ID}`)
    lines.push(`Status: ${team.status || 'unknown'}`)

    if (team.agents && team.agents.length > 0) {
      lines.push(`Agents (${team.agents.length}):`)
      for (const agent of team.agents) {
        const status = agent.status || 'unknown'
        const role = agent.role ? ` [${agent.role}]` : ''
        lines.push(`  - ${agent.name}${role}: ${status}`)
      }
    }

    if (team.task) {
      lines.push(`Task: ${team.task}`)
    }

    return toolResult(lines.join('\n'))
  } catch (err) {
    return toolError(`Cannot reach Agent-Forge API at ${API_URL}: ${err.message}`)
  }
}

/**
 * Signal completion — sends a "done" message that triggers auto-disband detection.
 */
async function handleTeamDone(args) {
  if (!TEAM_ID || !AGENT_NAME) {
    return toolError('ENSEMBLE_TEAM_ID and ENSEMBLE_AGENT_NAME must be set')
  }

  const summary = args.summary || 'Task completed.'

  try {
    // Send a completion message that the auto-disband detector will pick up
    const message = {
      from: AGENT_NAME,
      to: 'team',
      content: `Done. ${summary}`,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    }
    const result = await apiPost(`/api/ensemble/teams/${TEAM_ID}`, message)

    if (result.status >= 400) {
      return toolError(`Failed to signal completion: ${result.body?.error || result.status}`)
    }

    return toolResult(`Completion signaled: ${summary}. The team will auto-disband once all agents are done.`)
  } catch (err) {
    return toolError(`Cannot reach Agent-Forge API: ${err.message}`)
  }
}

/**
 * Share a structured plan — the system will detect and track steps.
 */
async function handleTeamPlan(args) {
  if (!TEAM_ID || !AGENT_NAME) {
    return toolError('ENSEMBLE_TEAM_ID and ENSEMBLE_AGENT_NAME must be set')
  }

  const steps = args.steps
  if (!Array.isArray(steps) || steps.length === 0) {
    return toolError('steps must be a non-empty array of strings')
  }

  // Format as a numbered list so the plan detector picks it up
  const planText = steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
  const content = `Plan:\n${planText}`

  try {
    const message = {
      from: AGENT_NAME,
      to: 'team',
      content,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    }
    const result = await apiPost(`/api/ensemble/teams/${TEAM_ID}`, message)

    if (result.status >= 400) {
      return toolError(`Failed to share plan: ${result.body?.error || result.status}`)
    }

    return toolResult(`Plan shared with ${steps.length} steps. The team can track progress in the Plan tab.`)
  } catch (err) {
    return toolError(`Cannot reach Agent-Forge API: ${err.message}`)
  }
}

/**
 * Ask the user a question — sends a 'question' type message that triggers
 * a UI banner for the user to respond.
 */
async function handleTeamAsk(args) {
  if (!TEAM_ID || !AGENT_NAME) {
    return toolError('ENSEMBLE_TEAM_ID and ENSEMBLE_AGENT_NAME must be set')
  }

  const question = args.question
  if (!question) {
    return toolError('question is required')
  }

  try {
    const message = {
      from: AGENT_NAME,
      to: 'user',
      content: question,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'question',
    }
    const result = await apiPost(`/api/ensemble/teams/${TEAM_ID}`, message)

    if (result.status >= 400) {
      return toolError(`Failed to ask question: ${result.body?.error || result.status}`)
    }

    return toolResult(`Question sent to user: "${question}". Check team_read for the response — the user will reply via the web UI.`)
  } catch (err) {
    return toolError(`Cannot reach Agent-Forge API: ${err.message}`)
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function toolResult(text) {
  return { content: [{ type: 'text', text }] }
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

function jsonRpcResponse(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

// ---------------------------------------------------------------------------
// JSON-RPC message handler
// ---------------------------------------------------------------------------

async function handleMessage(msg) {
  const { id, method, params } = msg

  // Notifications (no id) — no response needed
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      log('Client initialized')
    } else {
      log(`Received notification: ${method}`)
    }
    return null
  }

  switch (method) {
    case 'initialize': {
      log('Initializing...')
      return jsonRpcResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    }

    case 'tools/list': {
      return jsonRpcResponse(id, { tools: TOOLS })
    }

    case 'tools/call': {
      const toolName = params?.name
      const toolArgs = params?.arguments || {}

      log(`Calling tool: ${toolName}`)

      let result
      switch (toolName) {
        case 'team_say':
          result = await handleTeamSay(toolArgs)
          break
        case 'team_read':
          result = await handleTeamRead(toolArgs)
          break
        case 'team_status':
          result = await handleTeamStatus(toolArgs)
          break
        case 'team_done':
          result = await handleTeamDone(toolArgs)
          break
        case 'team_plan':
          result = await handleTeamPlan(toolArgs)
          break
        case 'team_ask':
          result = await handleTeamAsk(toolArgs)
          break
        default:
          return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`)
      }

      return jsonRpcResponse(id, result)
    }

    default: {
      return jsonRpcError(id, -32601, `Method not found: ${method}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

function send(obj) {
  const line = JSON.stringify(obj)
  process.stdout.write(line + '\n')
}

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    log(`Failed to parse JSON: ${trimmed}`)
    send(jsonRpcError(null, -32700, 'Parse error'))
    return
  }

  try {
    const response = await handleMessage(msg)
    if (response !== null) {
      send(response)
    }
  } catch (err) {
    log(`Error handling message: ${err.message}`)
    send(jsonRpcError(msg.id ?? null, -32603, `Internal error: ${err.message}`))
  }
})

rl.on('close', () => {
  log('stdin closed, shutting down')
  process.exit(0)
})

// Startup diagnostics
log(`Server starting (team=${TEAM_ID || '<not set>'}, agent=${AGENT_NAME || '<not set>'}, api=${API_URL})`)
