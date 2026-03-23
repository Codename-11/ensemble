import { useState, useEffect, useCallback } from 'react'

interface User {
  id: string
  username: string
  displayName?: string
  role: string
}

interface AuthState {
  user: User | null
  loading: boolean
  error: string | null
  login: (username: string, password: string) => Promise<boolean>
  logout: () => Promise<void>
  checkAuth: () => Promise<void>
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/ensemble/auth/me')
      if (res.ok) {
        const data = await res.json()
        setUser(data.user)
      } else {
        setUser(null)
      }
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    setError(null)
    try {
      const res = await fetch('/api/ensemble/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Login failed')
        return false
      }
      const data = await res.json()
      setUser(data.user)
      return true
    } catch (err) {
      setError('Connection failed')
      return false
    }
  }, [])

  const logout = useCallback(async () => {
    await fetch('/api/ensemble/auth/logout', { method: 'POST' })
    setUser(null)
  }, [])

  useEffect(() => { void checkAuth() }, [checkAuth])

  return { user, loading, error, login, logout, checkAuth }
}
