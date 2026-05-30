import { Injectable } from '@nestjs/common';
import { DEFAULT_TTS_VOICE, TTS_VOICES, isTtsVoice, type TtsVoiceT } from 'shared';
import { AppError, NotImplementedError, ValidationError } from '../../common/errors';
import { fetchWithTimeout } from '../../common/http/fetch';
import { parseSseJson } from '../../common/http/sse';
import { AudioService } from '../audio/audio.service';
import { TtsConfig } from './tts.config';

const SOURCE_SAMPLE_RATE = 24000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TTS_TEXT_CHARS = 500;
const MAX_TTS_STYLE_CHARS = 500;
const MAX_TTS_PCM_BYTES = 5 * 1024 * 1024;

export class TtsProviderError extends AppError {
  readonly code = 'tts_provider_error';
  readonly httpStatus = 502;
}

interface ChatCompletionChunk {
  error?: {
    message?: string;
    code?: string | number;
    type?: string;
  };
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
    private readonly config: TtsConfig,
    private readonly audio: AudioService
  ) {}

  voices(): TtsVoiceT[] {
    return [...TTS_VOICES];
  }

  defaultVoice(): TtsVoiceT {
    const voice = this.config.defaultVoice;
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
    if (text.length > MAX_TTS_TEXT_CHARS) {
      throw new ValidationError(`TTS 文案不能超过 ${MAX_TTS_TEXT_CHARS} 字`, {
        code: 'tts_text_too_long',
        max_chars: MAX_TTS_TEXT_CHARS,
      });
    }
    const style = input.style?.trim() ?? '';
    if (style.length > MAX_TTS_STYLE_CHARS) {
      throw new ValidationError(`TTS 风格描述不能超过 ${MAX_TTS_STYLE_CHARS} 字`, {
        code: 'tts_style_too_long',
        max_chars: MAX_TTS_STYLE_CHARS,
      });
    }
    const apiKey = this.config.apiKey;
    const baseUrl = this.config.baseUrl;
    if (!apiKey || !baseUrl) {
      throw new NotImplementedError('TTS_API_KEY 或 TTS_BASE_URL 未配置', {
        code: 'tts_not_configured',
      });
    }

    const rawPcm = await this.requestPcm16({
      text,
      voice: input.voice,
      style,
      apiKey,
      baseUrl,
    });
    return this.audio.resamplePcm16(rawPcm, SOURCE_SAMPLE_RATE);
  }

  private async requestPcm16(input: {
    text: string;
    voice: TtsVoiceT;
    style: string;
    apiKey: string;
    baseUrl: string;
  }): Promise<Buffer> {
    const url = `${input.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'user', content: input.style },
          { role: 'assistant', content: input.text },
        ],
        audio: { format: 'pcm16', voice: input.voice },
        stream: true,
      }),
    }).catch(async (err: unknown) => {
      throw new TtsProviderError(
        `TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new TtsProviderError(
        `TTS HTTP ${resp.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`
      );
    }
    if (!resp.body) throw new TtsProviderError('TTS 响应为空');

    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const data of parseSseJson<ChatCompletionChunk>(resp.body)) {
      if (data.error) {
        throw new TtsProviderError(`TTS stream error: ${formatTtsStreamError(data.error)}`);
      }
      const audio = data.choices?.[0]?.delta?.audio?.data;
      if (audio) {
        const chunk = Buffer.from(audio, 'base64');
        bytes += chunk.byteLength;
        if (bytes > MAX_TTS_PCM_BYTES) {
          throw new TtsProviderError(`TTS 音频超过 ${MAX_TTS_PCM_BYTES} bytes`);
        }
        chunks.push(chunk);
      }
    }
    const pcm = Buffer.concat(chunks);
    if (pcm.length === 0) throw new TtsProviderError('TTS 音频为空');
    if (pcm.length % 2 !== 0) {
      throw new TtsProviderError(`TTS PCM 长度未按 16-bit 对齐: ${pcm.length}`);
    }
    return pcm;
  }
}

function formatTtsStreamError(error: NonNullable<ChatCompletionChunk['error']>): string {
  const message = error.message?.trim();
  if (message) return message.slice(0, 240);
  if (error.code !== undefined) return String(error.code).slice(0, 80);
  if (error.type) return error.type.slice(0, 80);
  return 'unknown';
}
