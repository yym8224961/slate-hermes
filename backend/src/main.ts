import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './infra/config/app.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 32 * 1024 * 1024 }),
    { bufferLogs: true }
  );
  app.useLogger(app.get(Logger));

  const config = app.get(AppConfig);

  await app.register(import('@fastify/cookie') as never);
  await app.register(import('@fastify/cors') as never, {
    origin: config.corsOrigin,
    credentials: true,
  });
  await app.register(import('@fastify/multipart') as never, {
    limits: { fileSize: 32 * 1024 * 1024 },
  });

  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'healthz', method: RequestMethod.GET }],
  });

  // 单镜像生产部署 serve frontend dist;dev 模式 dist 不存在则跳过(走 vite dev server)。
  // backend/src/main.ts → ../../frontend/dist,runtime 镜像里同位置 (/app/backend/src)。
  const distRoot = join(import.meta.dir, '..', '..', 'frontend', 'dist');
  if (existsSync(distRoot)) {
    app.useStaticAssets({ root: distRoot, wildcard: false });

    // SPA fallback:NestFastifyApp init 阶段已经自己 setNotFoundHandler 一次,
    // fastify 同 prefix 不允许重复注册 → 改用 onSend hook 在响应发送前拦 404 改写。
    // 启动时一次性读 index.html 缓存,免每次磁盘 IO。
    // 带扩展名的资源(/favicon.ico 等)保持 404,避免 <img> 拿到 HTML 报损坏。
    const indexHtml = readFileSync(join(distRoot, 'index.html'));
    const fastify = app.getHttpAdapter().getInstance();
    fastify.addHook('onSend', async (req, reply, payload) => {
      if (reply.statusCode !== 404) return payload;
      const path = (req.url.split('?')[0] ?? '') as string;
      if (path.startsWith('/api/') || path === '/healthz') return payload;
      if (/\.[a-z0-9]+$/i.test(path)) return payload;
      void reply.code(200).type('text/html; charset=utf-8');
      return indexHtml;
    });
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

void bootstrap();
