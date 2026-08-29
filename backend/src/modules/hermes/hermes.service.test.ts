import { describe, expect, it } from 'bun:test';
import type { TtsService } from '../tts/tts.service';
import { AuthError, ConflictError, ForbiddenError } from '../../common/errors';
import type { DeviceContext } from '../../common/nest/auth-context';
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
    const chat = service.chat({ text: '你好' }, adminDevice('device-1'));
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
      const chat = service.chat({ audio }, adminDevice('device-1'));
      const pending = await service.agentGetPending(5);

      expect(pending).not.toBeNull();
      expect(pending?.text).toBe('');
      expect(pending?.audio).toBe(audio);
      expect(
        service.agentSubmitResponse({
          requestId: pending!.requestId,
          text: '收到语音了',
          userText: '请告诉我今天的天气',
        })
      ).toBe(true);
      expect(await chat).toEqual({
        text: '收到语音了',
        user_text: '请告诉我今天的天气',
      });
    } finally {
      if (previousBaseUrl === undefined) delete process.env['AI_BASE_URL'];
      else process.env['AI_BASE_URL'] = previousBaseUrl;
      if (previousApiKey === undefined) delete process.env['AI_API_KEY'];
      else process.env['AI_API_KEY'] = previousApiKey;
    }
  });

  it('limits a local STT transcript to the device history contract', async () => {
    const previousBaseUrl = process.env['AI_BASE_URL'];
    const previousApiKey = process.env['AI_API_KEY'];
    const previousFetch = globalThis.fetch;
    process.env['AI_BASE_URL'] = 'https://stt.example.com';
    process.env['AI_API_KEY'] = 'test-key';
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: '你'.repeat(600) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const service = new HermesService(tts(Buffer.alloc(0)), tokenStore());
      const audio = Buffer.from([0x01, 0x02]).toString('base64');
      const chat = service.chat({ audio }, adminDevice('device-1'));
      const pending = await service.agentGetPending(5);

      expect(pending?.text).toBe('你'.repeat(512));
      service.agentSubmitResponse({ requestId: pending!.requestId, text: '收到' });
      await expect(chat).resolves.toMatchObject({ user_text: '你'.repeat(512) });
    } finally {
      globalThis.fetch = previousFetch;
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

describe('HermesService isolation and token rotation', () => {
  it('rejects an unbound device before any work reaches the Gateway', async () => {
    const service = new HermesService(tts(Buffer.alloc(0)), tokenStore());

    await expect(
      service.chat({ text: '未绑定设备' }, { ...adminDevice('device-1'), ownerUserId: null })
    ).rejects.toThrow(ForbiddenError);
    expect(await service.agentGetPending(1, 0)).toBeNull();
  });

  it('accepts any bound device while keeping token management admin-only', async () => {
    const service = new HermesService(tts(Buffer.alloc(0)), tokenStore());
    const chat = service.chat(
      { text: '普通用户的设备' },
      { ...adminDevice('device-1'), ownerUserId: 'user-2' }
    );
    const pending = await service.agentGetPending(5, 0);

    expect(pending).toMatchObject({ userId: 'user-2', text: '普通用户的设备' });
    service.agentSubmitResponse({ requestId: pending!.requestId, text: '收到' });
    await expect(chat).resolves.toMatchObject({ text: '收到' });
  });

  it('includes a stable device session and owner identity in the Gateway request', async () => {
    const service = new HermesService(tts(Buffer.alloc(0)), tokenStore());
    const chat = service.chat({ text: '你好' }, adminDevice('device-1'));
    const pending = await service.agentGetPending(5, 0);

    expect(pending).toMatchObject({
      sessionId: 'slate:device-1',
      userId: 'admin-1',
    });
    service.agentSubmitResponse({ requestId: pending!.requestId, text: '你好呀' });
    await chat;
  });

  it('allows only one active Hermes request per device', async () => {
    const service = new HermesService(tts(Buffer.alloc(0)), tokenStore());
    const first = service.chat({ text: '第一条' }, adminDevice('device-1'));

    await expect(service.chat({ text: '第二条' }, adminDevice('device-1'))).rejects.toThrow(
      ConflictError
    );

    const pending = await service.agentGetPending(5, 0);
    service.agentSubmitResponse({ requestId: pending!.requestId, text: '完成' });
    await first;
  });

  it('invalidates an old long poll and resets connected state after token rotation', async () => {
    const store = revisionedTokenStore('a'.repeat(64));
    const service = new HermesService(tts(Buffer.alloc(0)), store);
    const oldPoll = service.agentGetPending(60_000, store.revision());

    expect(service.agentStatus()).toMatchObject({ connected: true });
    await service.configureAgentToken('b'.repeat(64));

    await expect(oldPoll).rejects.toThrow(AuthError);
    expect(service.agentStatus()).toMatchObject({ connected: false, last_seen_at: null });
  });

  it('rejects a stale token revision before it can receive a queued request', async () => {
    const store = revisionedTokenStore('a'.repeat(64));
    const service = new HermesService(tts(Buffer.alloc(0)), store);
    const staleRevision = store.revision();
    await service.configureAgentToken('b'.repeat(64));
    const chat = service.chat({ text: '秘密' }, adminDevice('device-1'));

    await expect(service.agentGetPending(5, staleRevision)).rejects.toThrow(AuthError);
    const pending = await service.agentGetPending(5, store.revision());
    expect(pending?.text).toBe('秘密');
    service.agentSubmitResponse({ requestId: pending!.requestId, text: '收到' });
    await chat;
  });

  it('does not invalidate work that was already acquired with the new token revision', async () => {
    let value = 'a'.repeat(64);
    let revision = 1;
    let acquireWithNewToken: Promise<Awaited<ReturnType<HermesService['agentGetPending']>>>;
    const store = {
      get: () => value,
      revision: () => revision,
      set: async (next: string) => {
        value = next;
        revision += 1;
        acquireWithNewToken = service.agentGetPending(5, revision);
      },
    } as HermesTokenStore;
    const service = new HermesService(tts(Buffer.alloc(0)), store);
    const chat = service.chat({ text: '新 Token 请求' }, adminDevice('device-1'));

    await service.configureAgentToken('b'.repeat(64));
    const pending = await acquireWithNewToken!;

    expect(
      service.agentSubmitResponse(
        { requestId: pending!.requestId, text: '新 Gateway 已处理' },
        store.revision()
      )
    ).toBe(true);
    await expect(chat).resolves.toMatchObject({ text: '新 Gateway 已处理' });
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
    revision: () => 0,
  } as HermesTokenStore;
}

function revisionedTokenStore(initial: string): HermesTokenStore {
  let value = initial;
  let revision = 1;
  return {
    get: () => value,
    revision: () => revision,
    set: async (next: string) => {
      value = next;
      revision += 1;
    },
  } as HermesTokenStore;
}

function adminDevice(deviceId: string): DeviceContext {
  return {
    deviceId,
    mac: 'AA:BB:CC:DD:EE:FF',
    ownerUserId: 'admin-1',
  };
}
