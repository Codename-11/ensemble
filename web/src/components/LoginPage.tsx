import { useState } from 'react'

interface LoginPageProps {
  onLogin: (username: string, password: string) => Promise<boolean>
  error: string | null
}

export function LoginPage({ onLogin, error }: LoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username || !password || submitting) return
    setSubmitting(true)
    try {
      await onLogin(username, password)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full items-start justify-center bg-background">
      <div className="w-full max-w-sm mx-auto mt-[20vh] px-4">
        <div className="rounded-xl border border-border bg-card p-8 shadow-lg">
          {/* Brand */}
          <div className="flex flex-col items-center gap-2 mb-8">
            <span className="text-4xl">⚒️</span>
            <h1 className="text-xl font-bold text-foreground tracking-tight">Agent-Forge</h1>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-2.5 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="username" className="text-sm font-medium text-muted-foreground">
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
                placeholder="Enter username"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-sm font-medium text-muted-foreground">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
                placeholder="Enter password"
              />
            </div>

            <button
              type="submit"
              disabled={submitting || !username || !password}
              className="mt-2 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        </div>

        {/* Tagline */}
        <p className="mt-6 text-center text-xs text-muted-foreground/60">
          Agent-Forge — Multi-agent collaboration engine
        </p>
      </div>
    </div>
  )
}
