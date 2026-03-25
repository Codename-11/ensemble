import fs from 'fs'
import os from 'os'
import path from 'path'
import { once } from 'events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'

const TSX_BIN = path.resolve(process.cwd(), 'node_modules', '.bin', os.platform() === 'win32' ? 'tsx.cmd' : 'tsx')

function getCookie(headers: Headers): string {
  const raw = headers.get('set-cookie')
  expect(raw).toBeTruthy()
  return raw!.split(';', 1)[0]
}

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/v1/health`)
      if (res.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Server did not become ready: ${url}`)
}

describe('Agent-Forge auth lockdown', () => {
  let tempRoot: string
  let server: ChildProcessWithoutNullStreams
  let baseUrl: string

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-auth-'))
    const port = 24000 + Math.floor(Math.random() * 1000)
    baseUrl = `http://127.0.0.1:${port}`

    server = spawn(TSX_BIN, ['server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_FORGE_PORT: String(port),
        AGENT_FORGE_HOST: '127.0.0.1',
        AGENT_FORGE_DATA_DIR: tempRoot,
        AGENT_FORGE_ADMIN_PASSWORD: 'admin-pass',
      },
      stdio: 'pipe',
    })

    await waitForServer(baseUrl)
  })

  afterEach(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM')
      await Promise.race([
        once(server, 'exit'),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ])
      if (!server.killed) server.kill('SIGKILL')
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  async function login(username: string, password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/agent-forge/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    expect(res.status).toBe(200)
    return getCookie(res.headers)
  }

  it('keeps public participation and read routes public on the canonical prefix', async () => {
    const healthRes = await fetch(`${baseUrl}/api/v1/health`)
    expect(healthRes.status).toBe(200)

    const lobbyRes = await fetch(`${baseUrl}/api/agent-forge/lobby`)
    expect(lobbyRes.status).toBe(200)

    const joinRes = await fetch(`${baseUrl}/api/agent-forge/teams/nonexistent/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Guest' }),
    })
    expect(joinRes.status).not.toBe(401)
  })

  it('rejects the removed /api/ensemble prefix', async () => {
    const cookie = await login('admin', 'admin-pass')

    const res = await fetch(`${baseUrl}/api/ensemble/config`, {
      headers: { cookie },
    })

    expect(res.status).toBe(404)
  })

  it('requires auth for non-public team write routes', async () => {
    const unauthCreate = await fetch(`${baseUrl}/api/agent-forge/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'unauth', description: 'x', agents: [{ program: 'claude', role: 'lead' }] }),
    })
    expect(unauthCreate.status).toBe(401)

    const cookie = await login('admin', 'admin-pass')
    const createRes = await fetch(`${baseUrl}/api/agent-forge/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'authed', description: 'x', agents: [{ program: 'claude', role: 'lead' }] }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json()
    const teamId = created.team.id as string

    const protectedRoutes = [
      { method: 'POST', path: `/api/agent-forge/teams/${teamId}`, body: { content: 'hi' } },
      { method: 'PATCH', path: `/api/agent-forge/teams/${teamId}`, body: { visibility: 'public' } },
      { method: 'POST', path: `/api/agent-forge/teams/${teamId}/clone`, body: {} },
      { method: 'POST', path: `/api/agent-forge/teams/${teamId}/summarize`, body: {} },
      { method: 'POST', path: `/api/agent-forge/teams/${teamId}/reopen`, body: {} },
      { method: 'POST', path: `/api/agent-forge/teams/${teamId}/share`, body: {} },
    ]

    for (const route of protectedRoutes) {
      const res = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(route.body),
      })
      expect(res.status, `${route.method} ${route.path}`).toBe(401)
    }
  })

  it('requires admin role for config, deploy, and user registration routes after bootstrap', async () => {
    const adminCookie = await login('admin', 'admin-pass')

    const registerRes = await fetch(`${baseUrl}/api/agent-forge/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ username: 'dev', password: 'dev-pass', displayName: 'Dev' }),
    })
    expect(registerRes.status).toBe(201)

    const userCookie = await login('dev', 'dev-pass')

    const userConfigRes = await fetch(`${baseUrl}/api/agent-forge/config`, {
      headers: { cookie: userCookie },
    })
    expect(userConfigRes.status).toBe(403)

    const userDeployRes = await fetch(`${baseUrl}/api/agent-forge/deploy/status`, {
      headers: { cookie: userCookie },
    })
    expect(userDeployRes.status).toBe(403)

    const userRegisterRes = await fetch(`${baseUrl}/api/agent-forge/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ username: 'nope', password: 'nope-pass' }),
    })
    expect(userRegisterRes.status).toBe(403)

    const adminConfigRes = await fetch(`${baseUrl}/api/agent-forge/config`, {
      headers: { cookie: adminCookie },
    })
    expect(adminConfigRes.status).toBe(200)
  })
})
