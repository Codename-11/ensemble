# Multi-stage build: build web SPA, then run server
FROM node:22-slim AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-slim
WORKDIR /app

# Install tmux for agent session management (Linux uses tmux, not node-pty)
RUN apt-get update && apt-get install -y --no-install-recommends tmux curl python3 && rm -rf /var/lib/apt/lists/*

# Install server dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Copy built web SPA
COPY --from=web-builder /app/web/dist ./web/dist

# The server serves the SPA from web/dist in production
ENV NODE_ENV=production
ENV ENSEMBLE_PORT=23000
EXPOSE 23000

CMD ["npx", "tsx", "server.ts"]
