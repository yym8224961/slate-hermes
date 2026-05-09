# syntax=docker/dockerfile:1

# ---------- builder ----------
FROM oven/bun:1 AS builder

WORKDIR /app

# 先拷依赖描述,利用层缓存(workspaces 需要每个子包的 package.json)
COPY package.json bun.lock ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY shared/package.json ./shared/

RUN bun install --frozen-lockfile

# 拷源码(.dockerignore 已排除 node_modules / dist / blobs / .git 等)
COPY . .

# Prisma client + frontend dist
RUN bun run --cwd backend prisma:generate \
 && bun run --cwd frontend build

# ---------- runner ----------
FROM oven/bun:1 AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    BLOB_DIR=/data/blobs

# curl 仅用于 HEALTHCHECK
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app /app

RUN chmod +x /app/entrypoint.sh

VOLUME ["/data/blobs"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/healthz" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
