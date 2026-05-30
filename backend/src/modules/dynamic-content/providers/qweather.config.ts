import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvT } from '../../../infra/config/env.schema';

@Injectable()
export class QweatherConfig {
  constructor(private readonly cs: ConfigService<EnvT, true>) {}

  get apiKey() {
    return this.cs.get('QWEATHER_API_KEY', { infer: true });
  }

  get apiHost() {
    return this.cs.get('QWEATHER_API_HOST', { infer: true });
  }
}
