import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal as XTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { X, Send, Loader2, CheckCircle2, AlertCircle, Square } from 'lucide-react'
import { cn } from '../lib/utils'
import '@xterm/xterm/css/xterm.css'

type SendState = 'idle' | 'sending' | 'sent' | 'error'

interface TerminalPanelProps {
  sessionName: string
  agentName: string
  onClose: () => void
}

export function TerminalPanel({ sessionName, agentName, onClose }: TerminalPanelProps) {
  const termContainerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const lastOutputRef = useRef('')

  const [sseConnected, setSseConnected] = useState(false)
  const [inputText, setInputText] = useState('')
  const [sendState, setSendState] = useState<SendState>('idle')

  // Initialize xterm
  useEffect(() => {
    if (!termContainerRef.current) return

    const terminal = new XTerminal({
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        selectionBackground: '#ffffff30',
        black: '#1a1a2e',
        brightBlack: '#555555',
      },
      fontFamily: "'Cascadia Code', 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      scrollback: 10000,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(termContainerRef.current)

    requestAnimationFrame(() => {
      try { fitAddon.fit() } catch { /* ignore */ }
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const handleResize = () => {
      try { fitAddon.fit() } catch { /* ignore */ }
    }
    window.addEventListener('resize', handleResize)

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(handleResize)
    })
    resizeObserver.observe(termContainerRef.current)

    return () => {
      window.removeEventListener('resize', handleResize)
      resizeObserver.disconnect()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  // Connect SSE stream
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    lastOutputRef.current = ''
    terminal.reset()

    const es = new EventSource(`/api/ensemble/sessions/${encodeURIComponent(sessionName)}/stream`)
    eventSourceRef.current = es

    es.addEventListener('open', () => {
      setSseConnected(true)
    })

    es.addEventListener('output', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { output?: string }
        const newOutput = data.output ?? ''
        const prevOutput = lastOutputRef.current

        if (newOutput === prevOutput) return // no change

        // Find the common prefix to only write new content
        // This avoids the flicker of reset+rewrite
        if (newOutput.startsWith(prevOutput) && prevOutput.length > 0) {
          // Append only the new tail
          const tail = newOutput.slice(prevOutput.length)
          if (tail) terminal.write(tail)
        } else {
          // Content changed fundamentally (scroll, screen clear, etc.) — full rewrite
          terminal.reset()
          terminal.write(newOutput)
        }

        lastOutputRef.current = newOutput
      } catch {
        // ignore parse errors
      }
    })

    es.addEventListener('error', () => {
      setSseConnected(false)
    })

    return () => {
      es.close()
      eventSourceRef.current = null
      setSseConnected(false)
    }
  }, [sessionName])

  // Send input to the session
  const handleSendInput = useCallback(async (text: string, interrupt = false) => {
    if (sendState === 'sending') return

    setSendState('sending')
    try {
      const body = interrupt
        ? { text: 'C-c', literal: false, enter: false }
        : { text, enter: true, literal: true }

      const res = await fetch(`/api/ensemble/sessions/${encodeURIComponent(sessionName)}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        setSendState('error')
        setTimeout(() => setSendState('idle'), 2000)
        return
      }

      if (!interrupt) setInputText('')
      setSendState('sent')
      setTimeout(() => setSendState('idle'), 1200)
    } catch {
      setSendState('error')
      setTimeout(() => setSendState('idle'), 2000)
    }
  }, [sessionName, sendState])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (inputText.trim()) {
        void handleSendInput(inputText)
      }
    }
  }, [inputText, handleSendInput])

  const sendButtonIcon = {
    idle: <Send className="size-3.5" />,
    sending: <Loader2 className="size-3.5 animate-spin" />,
    sent: <CheckCircle2 className="size-3.5" />,
    error: <AlertCircle className="size-3.5" />,
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
        <span
          className={cn(
            'inline-block size-2 shrink-0 rounded-full',
            sseConnected
              ? 'bg-emerald-500 animate-[pulse-dot_2s_ease-in-out_infinite]'
              : 'bg-muted-foreground/40',
          )}
          title={sseConnected ? 'Streaming' : 'Connecting...'}
        />
        <span className="text-xs font-medium text-foreground">{agentName}</span>
        <span className="text-[0.65rem] text-muted-foreground">terminal</span>
        <button
          onClick={onClose}
          className="ml-auto inline-flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Close terminal"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Terminal area */}
      <div
        ref={termContainerRef}
        className="flex-1 overflow-hidden p-1"
        style={{ backgroundColor: '#1a1a2e' }}
      />

      {/* Input bar */}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border bg-card px-3 py-2">
        <button
          onClick={() => void handleSendInput('', true)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 font-mono text-[0.65rem] text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
          title="Send Ctrl+C interrupt"
        >
          <Square className="size-2.5" />
          Ctrl+C
        </button>

        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command..."
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={sendState === 'sending'}
        />

        <button
          onClick={() => { if (inputText.trim()) void handleSendInput(inputText) }}
          disabled={sendState === 'sending' || !inputText.trim()}
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-40',
            sendState === 'sent' && 'border-agent-claude/30 text-agent-claude',
            sendState === 'error' && 'border-destructive/30 text-destructive',
            sendState === 'idle' && 'bg-primary text-primary-foreground hover:bg-primary/90',
            sendState === 'sending' && 'text-muted-foreground',
          )}
        >
          {sendButtonIcon[sendState]}
        </button>
      </div>
    </div>
  )
}
