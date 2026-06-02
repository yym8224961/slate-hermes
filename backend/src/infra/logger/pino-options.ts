import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import { AppConfig } from '../config/app.config';
import { safeRequestId } from '../../common/http/request-id';
import { isStaticAssetPath } from '../assets/static-assets';

export function buildLoggerParams(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.logLevel,
      genReqId: (req) => safeRequestId(req.headers['x-request-id']) ?? randomUUID(),
      autoLogging: {
        ignore: (req) => shouldSkipAccessLog(req.url),
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.headers["x-qw-api-key"]',
        'req.headers["x-qweather-api-key"]',
        'req.headers["x-tts-api-key"]',
        'req.headers["x-ai-api-key"]',
        'req.headers["x-app-token"]',
        'req.body.password',
        'req.body.token',
        'req.body.secret',
        'req.query.token',
        'req.query.api_key',
        'req.query.apiKey',
      ],
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

function shouldSkipAccessLog(url: string | undefined): boolean {
  const path = url?.split('?')[0] ?? '';
  if (path === '/healthz') return true;
  if (path.startsWith('/api/')) return false;
  return isStaticAssetPath(path);
}
