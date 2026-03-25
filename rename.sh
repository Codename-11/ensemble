#!/bin/bash
find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.md" -o -name "*.json" -o -name "*.mjs" -o -name "*.sh" -o -name "*.yml" -o -name "*.yaml" \) \
  -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.next/*" -not -path "*/dist/*" \
  -exec sed -i \
    -e 's/\/api\/agent-forge/\/api\/agent-forge/g' \
    -e 's/agentForgeService/agentForgeService/g' \
    -e 's/AgentForgeMessage/AgentForgeMessage/g' \
    -e 's/AgentForgeTeam/AgentForgeTeam/g' \
    -e 's/agent-forge-service/agent-forge-service/g' \
    -e 's/agent-forge-client/agent-forge-client/g' \
    -e 's/agent-forge-registry/agent-forge-registry/g' \
    -e 's/agent-forge-paths/agent-forge-paths/g' \
    -e 's/agent-forge-mcp-server/agent-forge-mcp-server/g' \
    -e 's/openclaw-agent-forge/openclaw-agent-forge/g' \
    -e 's/useAgentForge/useAgentForge/g' \
    -e 's/agent_forge_token/agent_forge_token/g' \
    -e 's/agent-forge: /agent-forge: /g' \
    -e 's/agent-forge\./agent-forge\./g' \
    -e 's/agent-forge-/agent-forge-/g' \
    {} +
