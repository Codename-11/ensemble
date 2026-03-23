import { useState, useCallback } from 'react'
import { Volume2, VolumeX, Menu, X, Wifi, WifiOff, Loader2, LogOut } from 'lucide-react'
import { cn } from '../lib/utils'
import { useRouter } from '../hooks/useRouter'
import { useSounds, getMuted } from '../hooks/useSounds'
import type { AuthUser } from '../types'

interface DashboardLayoutProps {
  children: React.ReactNode
  serverOnline?: boolean
  connecting?: boolean
  user?: AuthUser | null
  onLogout?: () => Promise<void>
}

const navItems = [
  { path: '/app', label: 'Teams', emoji: '🏠' },
  { path: '/app?new=1', label: 'New Team', emoji: '➕' },
  { path: '/app/history', label: 'History', emoji: '📼' },
  { path: '/lobby', label: 'Lobby', emoji: '🌐' },
  { path: '/app/settings', label: 'Settings', emoji: '⚙️' },
  { path: '/app/deploy', label: 'Deploy', emoji: '🚀' },
]

export function DashboardLayout({ children, serverOnline, connecting, user, onLogout }: DashboardLayoutProps) {
  const { pathname, navigate } = useRouter()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const sounds = useSounds()
  const [muted, setMuted] = useState(getMuted())

  const handleToggleMute = useCallback(() => {
    const nowMuted = sounds.toggleMute()
    setMuted(nowMuted)
  }, [sounds])

  // Determine active nav item
  const getIsActive = (path: string) => {
    const basePath = path.split('?')[0]
    if (basePath === '/app') {
      return pathname === '/app' || pathname === '/'
    }
    return pathname.startsWith(basePath)
  }

  const handleNavClick = (path: string) => {
    setSidebarOpen(false)
    navigate(path.split('?')[0])
    // If it's New Team, we signal via URL query then navigate
    if (path.includes('?new=1')) {
      window.dispatchEvent(new CustomEvent('ensemble:new-team'))
    }
  }

  const sidebar = (
    <nav className="flex flex-col h-full bg-zinc-950 border-r border-border">
      {/* Brand */}
      <div className="flex items-center gap-2 px-4 py-5 border-b border-border">
        <span className="text-xl">⚒️</span>
        <span className="font-bold text-foreground tracking-tight text-base">Agent-Forge</span>
      </div>

      {/* Nav items */}
      <ul className="flex flex-col gap-1 p-3 flex-1">
        {navItems.map(({ path, label, emoji }) => {
          const active = getIsActive(path)
          return (
            <li key={path}>
              <button
                onClick={() => handleNavClick(path)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left',
                  active
                    ? 'bg-primary/15 text-primary border-l-2 border-primary pl-[calc(0.75rem-2px)]'
                    : 'text-muted-foreground hover:bg-zinc-800 hover:text-foreground border-l-2 border-transparent',
                )}
              >
                <span className="text-base leading-none">{emoji}</span>
                <span>{label}</span>
              </button>
            </li>
          )
        })}
      </ul>

      {/* User info + Sign out */}
      {user && (
        <div className="border-t border-border px-4 py-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">
              {user.displayName || user.username}
            </p>
            <p className="text-xs text-muted-foreground truncate">{user.role}</p>
          </div>
          {onLogout && (
            <button
              onClick={onLogout}
              className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:bg-zinc-800 hover:text-foreground transition-colors"
              title="Sign out"
            >
              <LogOut className="size-4" />
            </button>
          )}
        </div>
      )}
    </nav>
  )

  return (
    <div className="flex h-full max-h-screen overflow-hidden bg-background">
      {/* Sidebar — desktop */}
      <div className="hidden lg:flex lg:w-64 lg:shrink-0 flex-col">
        {sidebar}
      </div>

      {/* Sidebar — mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="absolute left-0 top-0 bottom-0 w-64">
            {sidebar}
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
          {/* Mobile hamburger */}
          <button
            className="lg:hidden p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>

          {/* Mobile brand */}
          <div className="lg:hidden flex items-center gap-2">
            <span className="text-base">⚒️</span>
            <span className="font-bold text-sm">Agent-Forge</span>
          </div>

          <div className="flex-1" />

          {/* Connection status */}
          <div className="flex items-center gap-1.5">
            {connecting ? (
              <>
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground hidden sm:block">Connecting</span>
              </>
            ) : serverOnline === true ? (
              <>
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-green-500" />
                </span>
                <span className="text-xs text-muted-foreground hidden sm:block">Online</span>
              </>
            ) : serverOnline === false ? (
              <>
                <span className="inline-block size-2 rounded-full bg-red-500" />
                <span className="text-xs text-destructive hidden sm:block">Offline</span>
              </>
            ) : null}
          </div>

          {/* Mute toggle */}
          <button
            onClick={handleToggleMute}
            className={cn(
              'inline-flex items-center justify-center rounded-md p-1.5 transition-colors',
              muted
                ? 'text-muted-foreground/40 hover:bg-muted hover:text-foreground'
                : 'text-green-400 bg-green-500/10 hover:bg-green-500/20',
            )}
            title={muted ? 'Unmute sounds' : 'Mute sounds'}
          >
            {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
          </button>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  )
}
