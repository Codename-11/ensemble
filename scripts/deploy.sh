#!/bin/bash
# Agent-Forge deploy script
# Usage: ./scripts/deploy.sh
# Pulls latest, installs deps, builds SPA, restarts service

set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "⚒️  Agent-Forge deploy starting..."

# Pull latest
echo "📥 Pulling latest from origin/main..."
git pull origin main

# Install deps (root + web)
echo "📦 Installing dependencies..."
npm install --silent
cd web && npm install --silent

# Build SPA
echo "🔨 Building web SPA..."
npm run build

cd "$REPO_DIR"

# Restart service
echo "🔄 Restarting openclaw-agent-forge service..."
systemctl --user daemon-reload
systemctl --user restart openclaw-agent-forge

# Verify
sleep 2
if curl -s http://localhost:23000/api/v1/health | grep -q '"healthy"'; then
  echo "✅ Agent-Forge deployed successfully!"
else
  echo "❌ Health check failed — check logs: journalctl --user -u openclaw-agent-forge -n 50"
  exit 1
fi
