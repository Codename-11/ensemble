/**
 * Authentication module — SQLite-backed session auth for Agent-Forge
 *
 * Uses:
 * - better-sqlite3 for user/session storage
 * - crypto.scrypt for password hashing (Node built-in, no bcrypt needed)
 * - crypto.randomBytes for high-entropy session tokens
 * - HTTP-only cookies for session management
 */

import Database from 'better-sqlite3'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getAgentForgeDataDir } from './agent-forge-paths'

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (_db) return _db
  const dbPath = path.join(getAgentForgeDataDir(), 'auth.db')
  _db = initDb(dbPath)
  return _db
}

function initDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      displayName TEXT,
      role TEXT DEFAULT 'user',
      createdAt TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id)
    );
  `)

  return db
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!stored || !stored.includes(':')) return false
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const verify = crypto.scryptSync(password, salt, 64).toString('hex')
  const hashBuf = Buffer.from(hash, 'hex')
  const verifyBuf = Buffer.from(verify, 'hex')
  if (hashBuf.length !== verifyBuf.length) return false
  return crypto.timingSafeEqual(hashBuf, verifyBuf)
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export function createSession(userId: string): { token: string; expiresAt: string } {
  const db = getDb()
  const id = crypto.randomUUID()
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString()

  db.prepare(
    'INSERT INTO sessions (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)'
  ).run(id, userId, token, expiresAt)

  return { token, expiresAt }
}

export function validateSession(
  token: string
): { userId: string; username: string; displayName: string | null; role: string } | null {
  const db = getDb()

  const row = db.prepare(`
    SELECT s.userId, s.expiresAt, u.username, u.displayName, u.role
    FROM sessions s
    JOIN users u ON u.id = s.userId
    WHERE s.token = ?
  `).get(token) as
    | { userId: string; expiresAt: string; username: string; displayName: string | null; role: string }
    | undefined

  if (!row) return null

  // Check expiry
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    // Expired — clean it up
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    return null
  }

  return {
    userId: row.userId,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
  }
}

export function destroySession(token: string): void {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

/** Destroy all sessions for a user (logout everywhere) */
export function destroyAllUserSessions(userId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE userId = ?').run(userId)
}

/** Remove all expired sessions (housekeeping) */
export function cleanExpiredSessions(): void {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE expiresAt < strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\')').run()
}

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

export function createUser(
  username: string,
  password: string,
  displayName?: string
): { id: string; username: string } {
  const db = getDb()
  const id = crypto.randomUUID()
  const passwordHash = hashPassword(password)

  db.prepare(
    'INSERT INTO users (id, username, passwordHash, displayName) VALUES (?, ?, ?, ?)'
  ).run(id, username, passwordHash, displayName || null)

  return { id, username }
}

export function getUser(
  username: string
): { id: string; username: string; displayName: string | null; role: string; passwordHash: string } | null {
  const db = getDb()
  const row = db.prepare('SELECT id, username, displayName, role, passwordHash FROM users WHERE username = ?').get(
    username
  ) as { id: string; username: string; displayName: string | null; role: string; passwordHash: string } | undefined

  return row || null
}

export function listUsers(): Array<{ id: string; username: string; displayName: string | null; role: string }> {
  const db = getDb()
  return db.prepare('SELECT id, username, displayName, role FROM users').all() as Array<{
    id: string
    username: string
    displayName: string | null
    role: string
  }>
}

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

/**
 * Auto-create admin user if no users exist (first-run setup).
 * Uses AGENT_FORGE_ADMIN_PASSWORD env var or generates a random password.
 */
export function ensureAdminUser(): void {
  const db = getDb()
  const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }
  if (count.count === 0) {
    const envPassword = process.env.AGENT_FORGE_ADMIN_PASSWORD
    const defaultPassword = envPassword || crypto.randomBytes(9).toString('base64url').slice(0, 12)
    createUser('admin', defaultPassword, 'Administrator')
    // Update role to admin for the first user
    db.prepare('UPDATE users SET role = ? WHERE username = ?').run('admin', 'admin')
    console.log('[Agent-Forge] Created default admin user (username: admin)')
    if (envPassword) {
      console.log('[Agent-Forge] Using password from AGENT_FORGE_ADMIN_PASSWORD env var')
    } else {
      console.log(`[Agent-Forge] Generated password: ${defaultPassword}`)
      console.log('[Agent-Forge] Change it in Settings or set AGENT_FORGE_ADMIN_PASSWORD env var')
    }
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/** Parse cookies from the Cookie header string */
export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!cookieHeader) return cookies

  for (const pair of cookieHeader.split(';')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) continue
    const key = pair.slice(0, eqIdx).trim()
    const value = pair.slice(eqIdx + 1).trim()
    if (key) cookies[key] = decodeURIComponent(value)
  }

  return cookies
}

/** Build Set-Cookie header value for the session token */
export function buildSessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_MAX_AGE_MS / 1000) // 604800 seconds = 7 days
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `agent-forge-session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

/** Build Set-Cookie header value that clears the session cookie */
export function buildClearSessionCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `agent-forge-session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure}`
}
