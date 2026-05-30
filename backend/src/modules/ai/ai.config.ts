import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvT } from '../../infra/config/env.schema';

@Injectable()
export class AiConfig {
  constructor(private readonly cs: ConfigService<EnvT, true>) {}

  get apiKey() {
    return this.cs.get('AI_API_KEY', { infer: true });
  }

  get baseUrl() {
    return this.cs.get('AI_BASE_URL', { infer: true });
  }

  get model() {
    return this.cs.get('AI_MODEL', { infer: true });
  }
}
