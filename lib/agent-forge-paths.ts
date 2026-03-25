import os from 'os'
import path from 'path'

function trimConfiguredDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function getAgentForgeDataDir(): string {
  return trimConfiguredDir(process.env.AGENT_FORGE_DATA_DIR)
    || path.join(os.homedir(), '.agent-forge')
}

export function getAgentForgeRegistryDir(): string {
  return path.join(getAgentForgeDataDir(), 'registry')
}

export function getHostsConfigPath(): string {
  return path.join(getAgentForgeDataDir(), 'hosts.json')
}
