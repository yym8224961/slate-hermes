#!/bin/sh
set -e

# prisma 默认从 cwd 读 prisma.config.ts + prisma/schema.prisma
cd /app/backend
bunx prisma migrate deploy

cd /app
exec bun run backend/src/main.ts
