// 单镜像生产打包: bun bundle 一份 dist/main.js 给 runner stage 跑。
// external 列表 = NestJS 在 reflect 期间 require 但运行时不会真正命中的可选依赖,
// 全部 mark external 防止 bun 把它们打进 bundle (打进去会因找不到 peer 报错)。
import { build } from 'bun';

const result = await build({
  entrypoints: ['./src/main.ts'],
  outdir: './dist',
  target: 'bun',
  external: [
    'sharp',
    '@nestjs/websockets',
    '@nestjs/microservices',
    '@nestjs/platform-express',
    'class-validator',
    'class-transformer',
    '@fastify/view',
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
