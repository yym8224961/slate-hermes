import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvT } from './env.schema';

@Injectable()
export class AppConfig {
  constructor(private readonly cs: ConfigService<EnvT, true>) {}

  get nodeEnv() {
    return this.cs.get('NODE_ENV', { infer: true });
  }
  get logLevel() {
    return this.cs.get('LOG_LEVEL', { infer: true });
  }
  get port() {
    return this.cs.get('PORT', { infer: true });
  }
  get databaseUrl() {
    return this.cs.get('DATABASE_URL', { infer: true });
  }
  get jwtSecret() {
    return this.cs.get('JWT_SECRET', { infer: true });
  }
  get jwtExpiration() {
    return this.cs.get('JWT_EXPIRATION', { infer: true });
  }
  get webhookApiKey() {
    return this.cs.get('WEBHOOK_API_KEY', { infer: true });
  }
  get blobDir() {
    return this.cs.get('BLOB_DIR', { infer: true });
  }
  get devicePollIntervalSec() {
    return this.cs.get('DEVICE_POLL_INTERVAL_SECONDS', { infer: true });
  }
  get corsOrigin() {
    return this.cs.get('CORS_ORIGIN', { infer: true });
  }
  get isProd() {
    return this.nodeEnv === 'production';
  }
  get isDev() {
    return this.nodeEnv === 'development';
  }
}
