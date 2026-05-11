import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import { AppConfig } from '../config/app.config';

export function buildLoggerParams(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.logLevel,
      genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
      customProps: (req) => ({ method: req.method, url: req.url }),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      // 小项目，不区分 dev / prod，统一 pino-pretty 单行输出。
      // 真要喂日志聚合系统（Loki / Elastic），把 transport 删掉走默认 JSON 即可。
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: true,
        },
      },
    },
  };
}
