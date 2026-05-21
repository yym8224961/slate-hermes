import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile();
} catch {
  // .env 缺失时跳过，依赖外部已注入的环境变量
}

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
