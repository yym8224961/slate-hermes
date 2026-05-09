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

    // SPA fallback:启动时一次性读 index.html 缓存,NotFoundHandler 直接 send buffer。
    // 不走 @fastify/static 的 reply.sendFile,避免 fastify 多版本下声明合并失效。
    const indexHtml = readFileSync(join(distRoot, 'index.html'));

    const fastify = app.getHttpAdapter().getInstance();
    fastify.setNotFoundHandler((req, reply) => {
      const path = (req.url.split('?')[0] ?? '') as string;
      if (path.startsWith('/api/') || path === '/healthz') {
        void reply.status(404).send({ error: 'NotFound', message: `route ${path} not found` });
        return;
      }
      // 带扩展名的静态资源未找到 → 真 404,不要兜底成 HTML(避免 image 损坏)
      if (/\.[a-z0-9]+$/i.test(path)) {
        void reply.status(404).send();
        return;
      }
      // SPA 路由 → 返回 index.html 让前端 router 接管
      void reply.type('text/html').send(indexHtml);
    });
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

void bootstrap();
