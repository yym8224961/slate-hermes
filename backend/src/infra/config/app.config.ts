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
  get blobDir() {
    return this.cs.get('BLOB_DIR', { infer: true });
  }
  get dbAllowPublicKeyRetrieval() {
    return this.cs.get('DB_ALLOW_PUBLIC_KEY_RETRIEVAL', { infer: true });
  }
  get qweatherApiKey() {
    return this.cs.get('QWEATHER_API_KEY', { infer: true });
  }
  get qweatherApiHost() {
    return this.cs.get('QWEATHER_API_HOST', { infer: true });
  }
  get aiApiKey() {
    return this.cs.get('AI_API_KEY', { infer: true });
  }
  get aiBaseUrl() {
    return this.cs.get('AI_BASE_URL', { infer: true });
  }
  get aiModel() {
    return this.cs.get('AI_MODEL', { infer: true });
  }
  get ttsApiKey() {
    return this.cs.get('TTS_API_KEY', { infer: true });
  }
  get ttsBaseUrl() {
    return this.cs.get('TTS_BASE_URL', { infer: true });
  }
  get ttsModel() {
    return this.cs.get('TTS_MODEL', { infer: true });
  }
  get ttsDefaultVoice() {
    return this.cs.get('TTS_DEFAULT_VOICE', { infer: true });
  }
  get backgroundWorkers() {
    return this.cs.get('BACKGROUND_WORKERS', { infer: true });
  }
  get isProd() {
    return this.nodeEnv === 'production';
  }
  get isDev() {
    return this.nodeEnv === 'development';
  }
}
