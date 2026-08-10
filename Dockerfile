# syntax=docker/dockerfile:1

# Remote HTTP transport image (SPEC_remote-mcp.md R1). Stdio/local mode does not use this —
# it ships as the npm package / SEA executable instead (see tsup.sea.config.ts).

# ---- build ------------------------------------------------------------------
# better-sqlite3 is a native addon (tsup.config.ts marks it `external`, so it stays a real
# node_modules dependency at runtime, not bundled) — python3/make/g++ are here to compile it.
FROM node:20-slim AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# pnpm (pinned via package.json "packageManager") is this repo's lockfile source of truth —
# package-lock.json is git-ignored (npm is for local dev only per CLAUDE.md), so `npm ci`
# would fail on a fresh clone with no lockfile to install from. Corepack ships with node:20.
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# --frozen-lockfile: fail the build rather than silently drift from pnpm-lock.yaml.
# better-sqlite3's install script is allow-listed via package.json's
# pnpm.onlyBuiltDependencies, so this runs non-interactively (no `pnpm approve-builds` needed).
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# Drop devDependencies in place — this keeps the already-compiled better-sqlite3 binary
# instead of triggering a second native rebuild in a separate "install --prod" stage.
RUN pnpm prune --prod

# ---- runtime ------------------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app

# Non-root: the container only ever needs to read/write /app (read-only in practice) and
# the /data volume (SQLite state + audit log).
RUN groupadd --system forma \
    && useradd --system --gid forma --home-dir /app --shell /usr/sbin/nologin forma \
    && mkdir -p /data \
    && chown -R forma:forma /app /data

COPY --from=build --chown=forma:forma /app/node_modules ./node_modules
COPY --from=build --chown=forma:forma /app/dist ./dist
COPY --chown=forma:forma package.json ./

# Container default: remote multi-tenant HTTP mode with durable SQLite state on the mounted
# volume. Fly secrets (FORMA_MASTER_KEY, APS_CLIENT_ID/SECRET, ...) are supplied at deploy
# time — see fly.toml — not baked into the image.
ENV NODE_ENV=production \
    FORMA_TRANSPORT=http \
    FORMA_PERSISTENCE_MODE=sqlite \
    FORMA_DB_PATH=/data/state.db \
    FORMA_AUDIT_DIR=/data/audit

EXPOSE 8080
VOLUME ["/data"]
USER forma

CMD ["node", "dist/index.js"]
