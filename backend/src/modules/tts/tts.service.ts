import { Injectable } from '@nestjs/common';
import { DEFAULT_TTS_VOICE, TTS_VOICES, isTtsVoice, type TtsVoiceT } from 'shared';
import { NotImplementedError, ValidationError } from '../../common/errors';
import { fetchWithTimeout } from '../../common/http/fetch';
import { parseSseJson } from '../../common/http/sse';
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
    if (text.length > 500) {
      throw new ValidationError('TTS 文案不能超过 500 字', {
        code: 'tts_text_too_long',
        max_chars: 500,
      });
    }
    const apiKey = this.config.ttsApiKey;
    const baseUrl = this.config.ttsBaseUrl;
    if (!apiKey || !baseUrl) {
      throw new NotImplementedError('TTS_API_KEY 或 TTS_BASE_URL 未配置', {
        code: 'tts_not_configured',
      });
    }

    const rawPcm = await this.requestPcm16({
      text,
      voice: input.voice,
      style: input.style ?? '',
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
        model: this.config.ttsModel,
        messages: [
          { role: 'user', content: input.style },
          { role: 'assistant', content: input.text },
        ],
        audio: { format: 'pcm16', voice: input.voice },
        stream: true,
      }),
    }).catch(async (err: unknown) => {
      throw new Error(`TTS request failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`TTS HTTP ${resp.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
    }
    if (!resp.body) throw new Error('TTS 响应为空');

    const chunks: Buffer[] = [];
    for await (const data of parseSseJson<ChatCompletionChunk>(resp.body)) {
      const audio = data.choices?.[0]?.delta?.audio?.data;
      if (audio) chunks.push(Buffer.from(audio, 'base64'));
    }
    const pcm = Buffer.concat(chunks);
    if (pcm.length === 0) throw new Error('TTS 音频为空');
    return pcm;
  }
}
