import { useState, useCallback } from 'react'
import { Send, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '../lib/utils'
import type { AgentForgeTeamAgent } from '../types'

type SendState = 'idle' | 'sending' | 'sent' | 'error'

interface SteerInputProps {
  teamId?: string
  agents?: AgentForgeTeamAgent[]
  onSend: (content: string, to?: string) => Promise<void>
  disabled?: boolean
  placeholder?: string
}

export function SteerInput({ agents = [], onSend, disabled = false, placeholder }: SteerInputProps) {
  const [content, setContent] = useState('')
  const [target, setTarget] = useState('team')
  const [sendState, setSendState] = useState<SendState>('idle')

  const handleSend = useCallback(async () => {
    const trimmed = content.trim()
    if (!trimmed || sendState === 'sending') return

    setSendState('sending')
    try {
      await onSend(trimmed, target)
      setContent('')
      setSendState('sent')
      setTimeout(() => setSendState('idle'), 1500)
    } catch {
      setSendState('error')
      setTimeout(() => setSendState('idle'), 3000)
    }
  }, [content, target, sendState, onSend])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }, [handleSend])

  const buttonIcon = {
    idle: <Send className="size-4" />,
    sending: <Loader2 className="size-4 animate-spin" />,
    sent: <CheckCircle2 className="size-4" />,
    error: <AlertCircle className="size-4" />,
  }

  return (
    <div className="flex items-end gap-2 border-t border-border bg-card px-4 py-3 shrink-0">
      {/* Target selector */}
      <select
        className="shrink-0 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        value={target}
        onChange={e => setTarget(e.target.value)}
        disabled={disabled}
      >
        <option value="team">@ team</option>
        {agents.map(a => (
          <option key={a.name} value={a.name}>
            @ {a.name}
          </option>
        ))}
      </select>

      {/* Textarea */}
      <textarea
        className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        value={content}
        onChange={e => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Steer the team..."
        disabled={disabled || sendState === 'sending'}
        rows={1}
        style={{ minHeight: '38px', maxHeight: '120px' }}
      />

      {/* Send button */}
      <button
        className={cn(
          'inline-flex items-center justify-center shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          'border border-border',
          'focus:outline-none focus:ring-1 focus:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-40',
          sendState === 'sent' && 'border-agent-claude/30 text-agent-claude',
          sendState === 'error' && 'border-destructive/30 text-destructive',
          sendState === 'idle' && 'bg-primary text-primary-foreground hover:bg-primary/90',
          sendState === 'sending' && 'text-muted-foreground',
        )}
        onClick={() => void handleSend()}
        disabled={disabled || sendState === 'sending' || !content.trim()}
      >
        {buttonIcon[sendState]}
      </button>
    </div>
  )
}
