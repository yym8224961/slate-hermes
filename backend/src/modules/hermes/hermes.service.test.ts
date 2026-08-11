import { describe, expect, it } from 'bun:test';
import type { TtsService } from '../tts/tts.service';
import { HermesService, pcmToWav } from './hermes.service';
import type { HermesTokenStore } from './hermes-token.store';

describe('pcmToWav', () => {
  it('wraps raw 16 kHz mono PCM16 in a valid WAV header', () => {
    const pcm = Uint8Array.from([0x01, 0x02, 0x03, 0x04]);
    const wav = Buffer.from(pcmToWav(pcm));

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(40);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(pcm.byteLength);
    expect(wav.subarray(44)).toEqual(Buffer.from(pcm));
  });
});

describe('HermesService reply audio', () => {
  it('omits oversized TTS audio while preserving the text reply', async () => {
    const service = new HermesService(tts(Buffer.alloc(640001)), tokenStore());
    const chat = service.chat({ text: '你好' });
    const pending = await service.agentGetPending();

    expect(pending?.text).toBe('你好');
    expect(service.agentSubmitResponse({ requestId: pending!.requestId, text: '你好呀' })).toBe(
      true
    );
    expect(await chat).toEqual({ text: '你好呀' });
  });
});

describe('HermesService voice handoff', () => {
  it('forwards audio to Hermes Agent when Slate STT is not configured', async () => {
    const previousBaseUrl = process.env['AI_BASE_URL'];
    const previousApiKey = process.env['AI_API_KEY'];
    delete process.env['AI_BASE_URL'];
    delete process.env['AI_API_KEY'];

    try {
      const service = new HermesService(tts(Buffer.alloc(0)), tokenStore());
      const audio = Buffer.from([0x01, 0x02, 0x03, 0x04]).toString('base64');
      const chat = service.chat({ audio });
      const pending = await service.agentGetPending(5);

      expect(pending).not.toBeNull();
      expect(pending?.text).toBe('');
      expect(pending?.audio).toBe(audio);
      expect(
        service.agentSubmitResponse({ requestId: pending!.requestId, text: '收到语音了' })
      ).toBe(true);
      expect((await chat).text).toBe('收到语音了');
    } finally {
      if (previousBaseUrl === undefined) delete process.env['AI_BASE_URL'];
      else process.env['AI_BASE_URL'] = previousBaseUrl;
      if (previousApiKey === undefined) delete process.env['AI_API_KEY'];
      else process.env['AI_API_KEY'] = previousApiKey;
    }
  });
});

describe('HermesService agent status', () => {
  it('reports whether a configured Gateway has polled recently', async () => {
    const service = new HermesService(tts(Buffer.alloc(0)), tokenStore());

    expect(service.agentStatus(false)).toEqual({
      enabled: false,
      connected: false,
      last_seen_at: null,
    });

    const poll = service.agentGetPending(1);
    const status = service.agentStatus(true);

    expect(status.enabled).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.last_seen_at).not.toBeNull();
    expect(
      service.agentStatus(true, new Date(status.last_seen_at!).getTime() + 90_001).connected
    ).toBe(false);
    await poll;
  });
});

function tts(pcm: Buffer): TtsService {
  return {
    defaultVoice: () => '冰糖',
    synthesizeToDevicePcm: async () => pcm,
  } as unknown as TtsService;
}

function tokenStore(value?: string): HermesTokenStore {
  return {
    get: () => value,
    set: async () => undefined,
  } as HermesTokenStore;
}
