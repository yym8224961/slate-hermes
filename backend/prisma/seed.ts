// Seed admin user for local development.
// 用法: bun run --cwd backend prisma:seed
// 幂等: 已存在的 admin user 跳过。
//
// M3 render service 复活后会回填 "工程车系列" 12 帧。

import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

function makeAdapter(): PrismaMariaDb {
  const url = new URL(process.env.DATABASE_URL!);
  return new PrismaMariaDb({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    allowPublicKeyRetrieval: true,
  });
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({ adapter: makeAdapter() });
  try {
    const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
    const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123456';

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`✓ admin user ${email} already exists`);
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    await prisma.user.create({ data: { email, password: hash } });
    console.log(`✓ created admin user: ${email}`);
    console.log(
      process.env.SEED_ADMIN_PASSWORD
        ? '  (used SEED_ADMIN_PASSWORD env value)'
        : '  ⚠ used DEFAULT password "admin123456" — change after first login or set SEED_ADMIN_PASSWORD'
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
