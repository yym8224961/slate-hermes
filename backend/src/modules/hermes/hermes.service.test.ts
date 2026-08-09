import { describe, expect, it } from 'bun:test';
import type { TtsService } from '../tts/tts.service';
import { HermesService, pcmToWav } from './hermes.service';

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
    const service = new HermesService(tts(Buffer.alloc(640001)));
    const chat = service.chat({ text: '你好' });
    const pending = await service.agentGetPending();

    expect(pending?.text).toBe('你好');
    expect(service.agentSubmitResponse({ requestId: pending!.requestId, text: '你好呀' })).toBe(
      true
    );
    expect(await chat).toEqual({ text: '你好呀' });
  });
});

function tts(pcm: Buffer): TtsService {
  return {
    defaultVoice: () => '冰糖',
    synthesizeToDevicePcm: async () => pcm,
  } as unknown as TtsService;
}
