import { afterEach, describe, expect, it } from 'bun:test';
import { DEFAULT_TTS_VOICE } from 'shared';
import type { AppConfig } from '../../infra/config/app.config';
import type { AudioService } from '../audio/audio.service';
import { NotImplementedError, ValidationError } from '../../common/errors';
import { TtsProviderError, TtsService } from './tts.service';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

  it('rejects overly long TTS style prompts before calling the provider', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('unexpected');
    }) as unknown as typeof fetch;

    const service = new TtsService(
      {
        ttsApiKey: 'test-key',
        ttsBaseUrl: 'https://example.invalid',
        ttsDefaultVoice: DEFAULT_TTS_VOICE,
        ttsModel: 'tts-model',
      } as AppConfig,
      {} as AudioService
    );

    await expect(
      service.synthesizeToDevicePcm({
        text: 'hello',
        voice: DEFAULT_TTS_VOICE,
        style: 'x'.repeat(501),
      })
    ).rejects.toThrow(ValidationError);
    expect(calls).toBe(0);
  });

  it('rejects odd-length PCM chunks from the SSE stream', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const payload = {
            choices: [{ delta: { audio: { data: Buffer.from([1]).toString('base64') } } }],
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const service = new TtsService(
      {
        ttsApiKey: 'test-key',
        ttsBaseUrl: 'https://example.invalid',
        ttsDefaultVoice: DEFAULT_TTS_VOICE,
        ttsModel: 'tts-model',
      } as AppConfig,
      {
        resamplePcm16: async (buffer: Buffer) => buffer,
      } as AudioService
    );

    const result = service.synthesizeToDevicePcm({ text: 'hello', voice: DEFAULT_TTS_VOICE });
    await expect(result).rejects.toThrow('TTS PCM 长度未按 16-bit 对齐');
    await expect(result).rejects.toThrow(TtsProviderError);
    expect(calls).toBe(1);
  });

  it('rejects provider error events from the SSE stream', async () => {
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ error: { message: 'quota exceeded' } })}\n\n`
            )
          );
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const service = new TtsService(
      {
        ttsApiKey: 'test-key',
        ttsBaseUrl: 'https://example.invalid',
        ttsDefaultVoice: DEFAULT_TTS_VOICE,
        ttsModel: 'tts-model',
      } as AppConfig,
      {
        resamplePcm16: async (buffer: Buffer) => buffer,
      } as AudioService
    );

    await expect(
      service.synthesizeToDevicePcm({ text: 'hello', voice: DEFAULT_TTS_VOICE })
    ).rejects.toThrow('TTS stream error: quota exceeded');
  });

  it('aborts accumulation when the streamed PCM exceeds the audio blob limit', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0);
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 6; i += 1) {
            const payload = {
              choices: [{ delta: { audio: { data: chunk.toString('base64') } } }],
            };
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const service = new TtsService(
      {
        ttsApiKey: 'test-key',
        ttsBaseUrl: 'https://example.invalid',
        ttsDefaultVoice: DEFAULT_TTS_VOICE,
        ttsModel: 'tts-model',
      } as AppConfig,
      {
        resamplePcm16: async (buffer: Buffer) => buffer,
      } as AudioService
    );

    await expect(
      service.synthesizeToDevicePcm({ text: 'hello', voice: DEFAULT_TTS_VOICE })
    ).rejects.toThrow('TTS 音频超过');
  });
});
