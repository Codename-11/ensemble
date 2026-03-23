#!/usr/bin/env node
/**
 * ensemble-bridge.mjs — Cross-platform message bridge
 * Replaces ensemble-bridge.sh (which depends on bash/Python).
 *
 * Watches messages.jsonl and posts new entries to the Agent-Forge API.
 * Usage: node ensemble-bridge.mjs <team-id> [api-url]
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import http from 'http'

const [,, teamId, apiUrl] = process.argv
const API = apiUrl || 'http://localhost:23000'

if (!teamId) {
  console.error('Usage: node ensemble-bridge.mjs <team-id> [api-url]')
  process.exit(1)
}

const runtimeRoot = process.env.ENSEMBLE_RUNTIME_DIR
  || path.join(os.tmpdir(), 'ensemble')
const runtimeDir = path.join(runtimeRoot, teamId)
const messagesFile = path.join(runtimeDir, 'messages.jsonl')
const pidFile = path.join(runtimeDir, 'bridge.pid')
const postedFile = path.join(runtimeDir, 'bridge-posted')
const finishedFile = path.join(runtimeDir, '.finished')

// Ensure runtime dir exists
fs.mkdirSync(runtimeDir, { recursive: true })
if (!fs.existsSync(messagesFile)) {
  fs.writeFileSync(messagesFile, '')
}

// Single-instance guard
if (fs.existsSync(pidFile)) {
  const existingPid = fs.readFileSync(pidFile, 'utf-8').trim()
  if (existingPid) {
    try {
      process.kill(parseInt(existingPid, 10), 0) // Check if alive
      console.log(`[bridge] Already running for ${teamId} (pid ${existingPid})`)
      process.exit(0)
    } catch {
      // Process is dead, continue
    }
  }
}

// Write our PID
fs.writeFileSync(pidFile, String(process.pid))

// Cleanup on exit
function cleanup() {
  try { fs.unlinkSync(pidFile) } catch { /* ok */ }
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(0) })
process.on('SIGTERM', () => { cleanup(); process.exit(0) })

// Health check
async function healthCheck() {
  return new Promise((resolve) => {
    http.get(`${API}/api/v1/health`, { timeout: 3000 }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(res.statusCode === 200))
    }).on('error', () => resolve(false))
  })
}

// POST a message to the API
function postMessage(msg) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: msg.from || '',
      to: msg.to || 'team',
      content: msg.content || '',
      id: msg.id || '',
      timestamp: msg.timestamp || '',
    })

    const url = new URL(`${API}/api/ensemble/teams/${teamId}`)
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true)
        } else if (res.statusCode >= 400 && res.statusCode < 500) {
          // Client error — skip permanently
          console.error(`[bridge] client error ${res.statusCode}, skipping`)
          resolve(true)
        } else {
          reject(new Error(`Server error: ${res.statusCode}`))
        }
      })
    })

    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(payload)
    req.end()
  })
}

// Post with retries
async function postWithRetry(msg, lineNum) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await postMessage(msg)
      const from = msg.from || '?'
      const to = msg.to || '?'
      const content = (msg.content || '').slice(0, 60)
      console.error(`[bridge] ${from} -> ${to}: ${content}...`)
      return true
    } catch (err) {
      const delay = Math.min(30000, 500 * Math.pow(2, attempt))
      console.error(`[bridge] error line ${lineNum}, retry ${attempt + 1}/10 in ${delay}ms: ${err.message}`)
      if (attempt === 9) return false
      await new Promise(r => setTimeout(r, delay))
    }
  }
  return false
}

// Main loop
async function main() {
  const healthy = await healthCheck()
  if (!healthy) {
    console.error(`[bridge] health check failed for ${API}`)
    process.exit(1)
  }

  // Read initial posted count
  let posted = 0
  if (fs.existsSync(postedFile)) {
    const val = fs.readFileSync(postedFile, 'utf-8').trim()
    posted = parseInt(val, 10) || 0
  } else {
    fs.writeFileSync(postedFile, '0')
  }

  console.log(`[bridge] Watching ${messagesFile}`)

  while (true) {
    // Check for finished marker
    if (fs.existsSync(finishedFile)) {
      console.log('[bridge] finished marker detected, stopping')
      process.exit(0)
    }

    // Read messages file
    let lines = []
    try {
      const content = fs.readFileSync(messagesFile, 'utf-8')
      lines = content.split('\n').filter(l => l.trim())
    } catch {
      // File may not exist yet
    }

    const total = lines.length

    // Reset if file was truncated
    if (posted > total) {
      posted = 0
      fs.writeFileSync(postedFile, '0')
    }

    // Process new lines
    if (total > posted) {
      for (let i = posted; i < total; i++) {
        const line = lines[i].trim()
        if (!line) {
          posted = i + 1
          continue
        }

        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          console.error(`[bridge] skip malformed JSON line ${i}: ${line.slice(0, 80)}`)
          posted = i + 1
          continue
        }

        if (!msg || typeof msg !== 'object' || !msg.content) {
          posted = i + 1
          continue
        }

        const success = await postWithRetry(msg, i)
        if (!success) {
          console.error(`[bridge] giving up on line ${i} after 10 retries`)
          break
        }

        posted = i + 1
      }

      fs.writeFileSync(postedFile, String(posted))
    }

    await new Promise(r => setTimeout(r, 1000))
  }
}

main().catch(err => {
  console.error('[bridge] Fatal:', err)
  process.exit(1)
})
