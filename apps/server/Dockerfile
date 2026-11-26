# The chat server image. Build from the repository root (the server needs packages/core):
#   docker build --platform linux/amd64 -f apps/server/Dockerfile -t cas-p2p-chat-server .
# Node 26 runs the TypeScript sources directly (type stripping), so there is no build stage.
# Build for linux/amd64: cas-typescript-sdk ships linux-x64 binaries, not arm64.
FROM node:26-slim

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies of the server and core only (no Electron, Vue or dev tools).
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w @cas-p2p-chat/server && npm cache clean --force

COPY packages/core/src packages/core/src
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle

WORKDIR /app/apps/server
USER node
EXPOSE 8787
# Set DATABASE_URL (postgres://…?sslmode=verify-full). The image has no writable data directory
# for the embedded PGlite default.
CMD ["node", "--conditions=cas-source", "src/server.ts"]
