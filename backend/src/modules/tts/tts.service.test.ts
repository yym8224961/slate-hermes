import { describe, expect, it } from 'bun:test';
import { DEFAULT_TTS_VOICE } from 'shared';
import type { AppConfig } from '../../infra/config/app.config';
import type { AudioService } from '../audio/audio.service';
import { NotImplementedError } from '../../common/errors';
import { TtsService } from './tts.service';

describe('TtsService', () => {
  it('uses an app error when TTS credentials are not configured', async () => {
    const service = new TtsService(
      {
        ttsApiKey: undefined,
        ttsBaseUrl: undefined,
        ttsDefaultVoice: DEFAULT_TTS_VOICE,
      } as AppConfig,
      {} as AudioService
    );

    await expect(
      service.synthesizeToDevicePcm({ text: 'hello', voice: DEFAULT_TTS_VOICE })
    ).rejects.toThrow(NotImplementedError);
  });
});
