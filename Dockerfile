FROM node:24-bookworm-slim AS build
WORKDIR /app
# Compile better-sqlite3 if a matching prebuilt binary is unavailable.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build && npm prune --omit=dev

# Same Node major, Debian release and architecture as build for native SQLite ABI compatibility.
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production AUTH_MODE=oidc HOST=0.0.0.0 PORT=3000 DB_PATH=/data/ipam.db
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
