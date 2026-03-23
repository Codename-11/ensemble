import { cn } from '../lib/utils'

const AGENT_COLORS: Record<string, { dot: string; text: string }> = {
  codex:  { dot: 'bg-agent-codex',  text: 'text-agent-codex' },
  claude: { dot: 'bg-agent-claude', text: 'text-agent-claude' },
  gemini: { dot: 'bg-agent-gemini', text: 'text-agent-gemini' },
  aider:  { dot: 'bg-agent-aider',  text: 'text-agent-aider' },
}

function getAgentClasses(program: string): { dot: string; text: string } {
  const key = program.toLowerCase()
  for (const [name, classes] of Object.entries(AGENT_COLORS)) {
    if (key.includes(name)) return classes
  }
  return { dot: 'bg-agent-default', text: 'text-agent-default' }
}

interface AgentBadgeProps {
  name: string
  program: string
  size?: 'sm' | 'md'
}

export function AgentBadge({ name, program, size = 'sm' }: AgentBadgeProps) {
  const colors = getAgentClasses(program)
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          'inline-block shrink-0 rounded-full',
          size === 'sm' ? 'size-2' : 'size-2.5',
          colors.dot,
        )}
      />
      <span
        className={cn(
          'font-medium',
          size === 'sm' ? 'text-xs' : 'text-sm',
          colors.text,
        )}
      >
        {name}
      </span>
    </span>
  )
}
