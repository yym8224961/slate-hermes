import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import { AppConfig } from '../config/app.config';

export function buildLoggerParams(config: AppConfig): Params {
  const prettyTransport = config.isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: true,
        },
      };

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
      transport: prettyTransport,
    },
  };
}
