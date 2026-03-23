#!/usr/bin/env node
/**
 * team-read.mjs — Cross-platform team feed reader
 * Replaces team-read.sh (which depends on curl/Python).
 *
 * Usage: node team-read.mjs <team-id>
 */

import http from 'http'

const [,, teamId] = process.argv
const API = process.env.ENSEMBLE_URL || 'http://localhost:23000'

if (!teamId) {
  console.error('Usage: node team-read.mjs <team-id>')
  process.exit(1)
}

const url = `${API}/api/ensemble/teams/${teamId}/feed`

http.get(url, { timeout: 5000 }, (res) => {
  let data = ''
  res.on('data', chunk => data += chunk)
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data)
      const messages = parsed.messages || []
      for (const m of messages) {
        console.log(`${m.from} -> ${m.to}: ${m.content}`)
      }
    } catch {
      // Silently fail like the original
    }
  })
}).on('error', () => {
  // Silently fail like the original
})
