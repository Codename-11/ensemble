#!/usr/bin/env bash
# install-ubuntu.sh — Set up agent-forge on Ubuntu
set -euo pipefail

echo "Installing agent-forge dependencies..."

# System packages
sudo apt-get update
sudo apt-get install -y nodejs npm tmux python3 curl git

# Ensure Node 22+
if [[ $(node -v | cut -d. -f1 | tr -d v) -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Install project
npm install
cd web && npm install && npm run build && cd ..

echo ""
echo "Setup complete! Run:"
echo "  npm start    # production (serves SPA + API on port 23000)"
echo "  npm run dev  # development (separate Vite HMR)"
