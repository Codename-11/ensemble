import { useState, useEffect, useCallback, useRef } from 'react'
import type { AgentForgeTeam, AgentForgeMessage } from '../types'

const POLL_INTERVAL_MS = 2000

interface UseAgentForgeReturn {
  team: AgentForgeTeam | null
  messages: AgentForgeMessage[]
  connected: boolean
  error: string | null
  sendMessage: (content: string, to?: string) => Promise<void>
  disbandTeam: () => Promise<void>
}

export function useAgentForge(teamId: string | null): UseAgentForgeReturn {
  const [team, setTeam] = useState<AgentForgeTeam | null>(null)
  const [messages, setMessages] = useState<AgentForgeMessage[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastMessageTimestamp = useRef<string | undefined>(undefined)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch team details
  const fetchTeam = useCallback(async () => {
    if (!teamId) return
    try {
      const res = await fetch(`/api/agent-forge/teams/${teamId}`)
      if (!res.ok) {
        setError(`Failed to fetch team: ${res.status}`)
        return
      }
      const data = await res.json()
      const rawTeam = data.team ?? data
      // Ensure migration defaults for new fields
      setTeam({
        visibility: 'private',
        lifecycle: 'ephemeral',
        participants: [],
        ...rawTeam,
      })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch team')
    }
  }, [teamId])

  // Fetch messages (feed) with optional since parameter
  const fetchFeed = useCallback(async () => {
    if (!teamId) return
    try {
      const params = lastMessageTimestamp.current
        ? `?since=${encodeURIComponent(lastMessageTimestamp.current)}`
        : ''
      const res = await fetch(`/api/agent-forge/teams/${teamId}/feed${params}`)
      if (!res.ok) return
      const data = await res.json()
      const feedMessages: AgentForgeMessage[] = data.messages ?? data
      if (feedMessages.length > 0) {
        lastMessageTimestamp.current = feedMessages[feedMessages.length - 1].timestamp
        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id))
          const newMessages = feedMessages.filter(m => !existingIds.has(m.id))
          return newMessages.length > 0 ? [...prev, ...newMessages] : prev
        })
      }
      setConnected(true)
      setError(null)
    } catch (err) {
      setConnected(false)
      setError(err instanceof Error ? err.message : 'Failed to fetch feed')
    }
  }, [teamId])

  // Start polling when teamId is set
  useEffect(() => {
    if (!teamId) {
      setTeam(null)
      setMessages([])
      setConnected(false)
      setError(null)
      lastMessageTimestamp.current = undefined
      return
    }

    // Initial fetch
    void fetchTeam()
    void fetchFeed()

    // Poll for updates
    pollRef.current = setInterval(() => {
      void fetchTeam()
      void fetchFeed()
    }, POLL_INTERVAL_MS)

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [teamId, fetchTeam, fetchFeed])

  // Send a message to the team or a specific agent
  const sendMessage = useCallback(async (content: string, to = 'team') => {
    if (!teamId) return
    try {
      const res = await fetch(`/api/agent-forge/teams/${teamId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          to,
          from: 'user',
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const message = (body as { error?: string }).error || `Send failed: ${res.status}`
        setError(message)
        throw new Error(message)
      }
      setError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send message'
      setError(message)
      throw err instanceof Error ? err : new Error(message)
    }
  }, [teamId])

  // Disband the team
  const disbandTeam = useCallback(async () => {
    if (!teamId) return
    try {
      const res = await fetch(`/api/agent-forge/teams/${teamId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error || `Disband failed: ${res.status}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disband team')
    }
  }, [teamId])

  return { team, messages, connected, error, sendMessage, disbandTeam }
}
