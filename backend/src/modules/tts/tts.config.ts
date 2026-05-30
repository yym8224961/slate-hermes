import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvT } from '../../infra/config/env.schema';

@Injectable()
export class TtsConfig {
  constructor(private readonly cs: ConfigService<EnvT, true>) {}

  get apiKey() {
    return this.cs.get('TTS_API_KEY', { infer: true });
  }

  get baseUrl() {
    return this.cs.get('TTS_BASE_URL', { infer: true });
  }

  get model() {
    return this.cs.get('TTS_MODEL', { infer: true });
  }

  get defaultVoice() {
    return this.cs.get('TTS_DEFAULT_VOICE', { infer: true });
  }
}
