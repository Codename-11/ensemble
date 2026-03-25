import { useState, useEffect, useCallback } from 'react'
import { useRouter } from './hooks/useRouter'
import { navigate } from './hooks/useRouter'
import { useAuth } from './hooks/useAuth'
import { DashboardLayout } from './components/DashboardLayout'
import { PublicLayout } from './components/PublicLayout'
import { LoginPage } from './components/LoginPage'
import { TeamListView } from './components/TeamListView'
import { HistoryView } from './components/HistoryView'
import { Monitor } from './components/Monitor'
import { SettingsPage } from './components/SettingsPage'
import { DeployPage } from './components/DeployPage'
import { LandingPage } from './components/LandingPage'
import { SpectatorView } from './components/SpectatorView'
import { ReplayView } from './components/ReplayView'
import { DocsPage } from './components/DocsPage'
import { useAgentForge } from './hooks/useAgentForge'

// Landing page state — fetched from server /api/agent-forge/info
let _landingEnabled: boolean | null = null
function isLandingEnabled(): boolean {
  if (_landingEnabled !== null) return _landingEnabled
  // Check meta tag as fast fallback (set by server in HTML template)
  const meta = document.querySelector('meta[name="agent-forge-landing"]')
  if (meta) return meta.getAttribute('content') !== 'false'
  return true
}
// Fetch from server on load (overrides meta tag)
fetch('/api/agent-forge/info').then(r => r.ok ? r.json() : null).then(data => {
  if (data?.landingPageEnabled !== undefined) _landingEnabled = data.landingPageEnabled
}).catch(() => {})

export function App() {
  const { pathname } = useRouter()
  const { user, loading, error: authError, login, logout } = useAuth()
  const [serverOnline, setServerOnline] = useState<boolean | undefined>(undefined)
  const [connecting, setConnecting] = useState(true)

  // Monitor view state
  const [monitorTeamId, setMonitorTeamId] = useState<string | null>(() => {
    const m = pathname.match(/^\/app\/team\/([^/?]+)/)
    return m ? m[1] : null
  })

  const { team, messages, connected, error, sendMessage, disbandTeam } = useAgentForge(monitorTeamId)

  // Sync monitorTeamId from URL changes
  useEffect(() => {
    const m = pathname.match(/^\/app\/team\/([^/?]+)/)
    setMonitorTeamId(m ? m[1] : null)
  }, [pathname])

  const handleServerStatus = useCallback((online: boolean, isConnecting: boolean) => {
    setServerOnline(online)
    setConnecting(isConnecting)
  }, [])

  // ── Loading screen while checking auth ───────────────────────
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full border-2 border-muted border-t-primary size-6" />
          <span className="text-sm text-muted-foreground">Loading...</span>
        </div>
      </div>
    )
  }

  // ── Public routes ──────────────────────────────────────────

  // Landing page (root route when landing is enabled)
  if (pathname === '/' && isLandingEnabled()) {
    return (
      <PublicLayout>
        <LandingPage
          onCreateTeam={() => navigate('/app?new=1')}
          onWatchTeam={(teamId) => navigate(`/team/${teamId}`)}
          onDashboard={() => navigate('/app')}
        />
      </PublicLayout>
    )
  }

  // Public spectator view
  if (pathname.startsWith('/team/')) {
    const teamId = pathname.replace('/team/', '').split('/')[0]
    const token = new URLSearchParams(window.location.search).get('token') ?? undefined
    return (
      <PublicLayout>
        <SpectatorView
          teamId={teamId}
          token={token}
          onBack={() => navigate('/')}
          onWatchReplay={(id) => navigate(`/replay/${id}`)}
        />
      </PublicLayout>
    )
  }

  // Public replay view
  if (pathname.startsWith('/replay/')) {
    const teamId = pathname.replace('/replay/', '').split('/')[0]
    return (
      <PublicLayout>
        <ReplayView
          teamId={teamId}
          onBack={() => navigate('/')}
        />
      </PublicLayout>
    )
  }

  // Public docs
  if (pathname === '/docs') {
    return (
      <PublicLayout>
        <DocsPage isPublic />
      </PublicLayout>
    )
  }

  // Public lobby
  if (pathname === '/lobby') {
    return (
      <PublicLayout>
        <LandingPage
          onCreateTeam={() => navigate('/app?new=1')}
          onWatchTeam={(teamId) => navigate(`/team/${teamId}`)}
          onDashboard={() => navigate('/app')}
        />
      </PublicLayout>
    )
  }

  // ── Login page ─────────────────────────────────────────────

  if (pathname === '/login') {
    if (user) {
      navigate('/app')
      return null
    }
    return <LoginPage onLogin={login} error={authError} />
  }

  // ── Dashboard routes — require auth ────────────────────────

  if (pathname.startsWith('/app')) {
    if (!user) {
      navigate('/login')
      return null
    }

    // Docs
    if (pathname === '/app/docs') {
      return (
        <DashboardLayout serverOnline={serverOnline} connecting={connecting} user={user} onLogout={logout}>
          <DocsPage onBack={() => navigate('/app')} />
        </DashboardLayout>
      )
    }

    // Settings
    if (pathname === '/app/settings') {
      return (
        <DashboardLayout serverOnline={serverOnline} connecting={connecting} user={user} onLogout={logout}>
          <SettingsPage onBack={() => navigate('/app')} />
        </DashboardLayout>
      )
    }

    // Deploy
    if (pathname === '/app/deploy') {
      return (
        <DashboardLayout serverOnline={serverOnline} connecting={connecting} user={user} onLogout={logout}>
          <DeployPage onBack={() => navigate('/app')} />
        </DashboardLayout>
      )
    }

    // History
    if (pathname === '/app/history') {
      return (
        <DashboardLayout serverOnline={serverOnline} connecting={connecting} user={user} onLogout={logout}>
          <HistoryView />
        </DashboardLayout>
      )
    }

    // Monitor (team detail)
    if (pathname.startsWith('/app/team/')) {
      return (
        <DashboardLayout serverOnline={serverOnline} connecting={connecting} user={user} onLogout={logout}>
          <div className="flex h-full max-h-full flex-col overflow-hidden">
            {monitorTeamId && team ? (
              <Monitor
                team={team}
                messages={messages}
                connected={connected}
                error={error}
                onSend={sendMessage}
                onDisband={disbandTeam}
                onBack={() => navigate('/app')}
                onNavigateToTeam={(id) => navigate(`/app/team/${id}`)}
              />
            ) : monitorTeamId ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
                <div className="animate-spin rounded-full border-2 border-muted border-t-primary size-6" />
                <span className="text-sm">Loading team...</span>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
                <span className="text-sm">Team not found</span>
              </div>
            )}
          </div>
        </DashboardLayout>
      )
    }

    // Dashboard home (/app)
    return (
      <DashboardLayout serverOnline={serverOnline} connecting={connecting} user={user} onLogout={logout}>
        <TeamListView onServerStatus={handleServerStatus} />
      </DashboardLayout>
    )
  }

  // ── Smart redirect at / (when landing page is disabled) ────

  navigate(user ? '/app' : '/login')
  return null
}
