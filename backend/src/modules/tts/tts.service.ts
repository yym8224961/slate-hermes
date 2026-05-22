import { Injectable } from '@nestjs/common';
import { DEFAULT_TTS_VOICE, TTS_VOICES, isTtsVoice, type TtsVoiceT } from 'shared';
import { ValidationError } from '../../common/errors';
import { AppConfig } from '../../infra/config/app.config';
import { AudioService } from '../audio/audio.service';

const SOURCE_SAMPLE_RATE = 24000;
const REQUEST_TIMEOUT_MS = 60_000;

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      audio?: {
        data?: string;
      };
    };
  }>;
}

@Injectable()
export class TtsService {
  constructor(
    private readonly config: AppConfig,
    private readonly audio: AudioService
  ) {}

  voices(): TtsVoiceT[] {
    return [...TTS_VOICES];
  }

  defaultVoice(): TtsVoiceT {
    const voice = this.config.ttsDefaultVoice;
    return isTtsVoice(voice) ? voice : DEFAULT_TTS_VOICE;
  }

  normalizeVoice(voice: string | null | undefined): TtsVoiceT {
    if (!voice) return this.defaultVoice();
    if (isTtsVoice(voice)) return voice;
    throw new ValidationError(`未知音色: ${voice}`);
  }

  async synthesizeToDevicePcm(input: {
    text: string;
    voice: TtsVoiceT;
    style?: string;
  }): Promise<Buffer> {
    const text = input.text.trim();
    if (!text) throw new ValidationError('TTS 文案不能为空');
    if (!this.config.ttsApiKey || !this.config.ttsBaseUrl) {
      throw new Error('TTS_API_KEY 或 TTS_BASE_URL 未配置');
    }

    const rawPcm = await this.requestPcm16({
      text: text.slice(0, 500),
      voice: input.voice,
      style: input.style ?? '',
    });
    return this.audio.resamplePcm16(rawPcm, SOURCE_SAMPLE_RATE);
  }

  private async requestPcm16(input: {
    text: string;
    voice: TtsVoiceT;
    style: string;
  }): Promise<Buffer> {
    if (!this.config.ttsApiKey || !this.config.ttsBaseUrl) {
      throw new Error('TTS_API_KEY 或 TTS_BASE_URL 未配置');
    }
    const url = `${this.config.ttsBaseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.ttsApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.ttsModel,
          messages: [
            { role: 'user', content: input.style },
            { role: 'assistant', content: input.text },
          ],
          audio: { format: 'pcm16', voice: input.voice },
          stream: true,
        }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`TTS HTTP ${resp.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
      }
      if (!resp.body) throw new Error('TTS 响应为空');

      const chunks: Buffer[] = [];
      for await (const data of parseSseJson(resp.body)) {
        const audio = data.choices?.[0]?.delta?.audio?.data;
        if (audio) chunks.push(Buffer.from(audio, 'base64'));
      }
      const pcm = Buffer.concat(chunks);
      if (pcm.length === 0) throw new Error('TTS 音频为空');
      return pcm;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function* parseSseJson(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<ChatCompletionChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let boundary: RegExpMatchArray | null;
      while ((boundary = buf.match(/\r?\n\r?\n/))) {
        const idx = boundary.index ?? 0;
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + boundary[0].length);
        const data = parseSseBlock(block);
        if (data === null) continue;
        yield data;
      }
    }
    buf += decoder.decode();
    const data = parseSseBlock(buf);
    if (data !== null) yield data;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): ChatCompletionChunk | null {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'));
  if (lines.length === 0) return null;
  const payload = lines.map((line) => line.slice(5).trim()).join('\n');
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as ChatCompletionChunk;
  } catch {
    return null;
  }
}
