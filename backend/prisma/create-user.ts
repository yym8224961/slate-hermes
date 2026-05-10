// 创建用户。
// 用法: bun run prisma/create-user.ts <email> <password>

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
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    throw new Error('用法: bun run prisma/create-user.ts <email> <password>');
  }

  const prisma = new PrismaClient({ adapter: makeAdapter() });
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new Error(`用户 ${email} 已存在`);
    }
    const hash = await bcrypt.hash(password, 10);
    await prisma.user.create({ data: { email, password: hash } });
    console.log(`✓ 创建用户: ${email}`);
  } finally {
    // 必须走 finally —— 用 process.exit 会跳过它,prisma 连接没干净关
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
