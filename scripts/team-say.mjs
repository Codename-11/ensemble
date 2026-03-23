#!/usr/bin/env node
/**
 * team-say.mjs — Cross-platform message sender for team feed
 * Replaces team-say.sh (which depends on Python fcntl).
 *
 * Usage: node team-say.mjs <team-id> <from> <to> <message>
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

const [,, teamId, from, to, ...msgParts] = process.argv
const message = msgParts.join(' ')

if (!teamId || !from || !to || !message) {
  console.error('Usage: node team-say.mjs <team-id> <from> <to> <message>')
  process.exit(1)
}

const runtimeRoot = process.env.ENSEMBLE_RUNTIME_DIR
  || path.join(os.tmpdir(), 'ensemble')
const messagesFile = path.join(runtimeRoot, teamId, 'messages.jsonl')
const lockDir = messagesFile + '.lock'

// Ensure directory exists
fs.mkdirSync(path.dirname(messagesFile), { recursive: true })

// Build JSONL message
const msg = JSON.stringify({
  id: randomUUID(),
  teamId,
  from,
  to,
  content: message,
  type: 'chat',
  timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
}) + '\n'

// Cross-platform file locking using mkdir (atomic on all platforms)
const MAX_RETRIES = 50
const RETRY_DELAY_MS = 20

async function acquireLock() {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      fs.mkdirSync(lockDir)
      return true
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Check if lock is stale (older than 5 seconds)
        try {
          const stat = fs.statSync(lockDir)
          if (Date.now() - stat.mtimeMs > 5000) {
            fs.rmdirSync(lockDir)
            continue
          }
        } catch { /* stat/rmdir failed, retry */ }
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
        continue
      }
      throw err
    }
  }
  // Force-break stale lock after max retries
  try { fs.rmdirSync(lockDir) } catch { /* ok */ }
  return false
}

function releaseLock() {
  try { fs.rmdirSync(lockDir) } catch { /* ok */ }
}

try {
  await acquireLock()
  fs.appendFileSync(messagesFile, msg)
  releaseLock()
  console.log(`Sent to ${to}`)
} catch (err) {
  releaseLock()
  console.error('Failed to send message:', err.message)
  process.exit(1)
}
