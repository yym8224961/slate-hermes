import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DEFAULT_TTS_VOICE, TTS_VOICES, isTtsVoice, type TtsVoiceT } from 'shared';
import { computeETag } from '../../common/etag/etag.util';
import { ValidationError } from '../../common/errors';
import { BlobService } from '../../infra/blob/blob.service';
import { AppConfig } from '../../infra/config/app.config';
import { PrismaService } from '../../infra/prisma/prisma.service';
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

export interface TtsCacheInput {
  text: string;
  voice: TtsVoiceT;
  model?: string;
  style?: string;
}

export interface TtsCacheHit {
  etag: string;
  size: number;
}

@Injectable()
export class TtsAudioCacheService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly config: AppConfig,
    private readonly tts: TtsService
  ) {}

  key(input: TtsCacheInput): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          text: input.text.trim().slice(0, 500),
          voice: input.voice,
          model: input.model ?? this.config.ttsModel,
          style: input.style ?? '',
        })
      )
      .digest('hex');
  }

  async findReady(input: TtsCacheInput): Promise<TtsCacheHit | null> {
    const row = await this.prisma.ttsAudioCache.findUnique({
      where: { cacheKey: this.key(input) },
      select: { etag: true, size: true },
    });
    if (!row) return null;
    const bytes = await this.blob.readGlobal(ttsCacheBlobId(row.etag), 'audio');
    if (!bytes || bytes.byteLength !== row.size) {
      await this.prisma.ttsAudioCache
        .delete({ where: { cacheKey: this.key(input) } })
        .catch(() => undefined);
      return null;
    }
    return row;
  }

  async getOrCreate(input: TtsCacheInput): Promise<TtsCacheHit> {
    const cached = await this.findReady(input);
    if (cached) return cached;

    const normalized = {
      text: input.text.trim().slice(0, 500),
      voice: input.voice,
      model: input.model ?? this.config.ttsModel,
      style: input.style ?? '',
    };
    const key = this.key(normalized);
    const bytes = await this.tts.synthesizeToDevicePcm(normalized);
    const etag = computeETag(bytes);
    await this.blob.writeGlobal(ttsCacheBlobId(etag), 'audio', bytes);
    return this.prisma.ttsAudioCache.upsert({
      where: { cacheKey: key },
      create: {
        cacheKey: key,
        text: normalized.text,
        voice: normalized.voice,
        model: normalized.model,
        style: normalized.style,
        etag,
        size: bytes.byteLength,
      },
      update: {
        text: normalized.text,
        voice: normalized.voice,
        model: normalized.model,
        style: normalized.style,
        etag,
        size: bytes.byteLength,
      },
      select: { etag: true, size: true },
    });
  }

  async readByEtag(etag: string): Promise<Buffer | null> {
    return this.blob.readGlobal(ttsCacheBlobId(etag), 'audio');
  }
}

export function ttsCacheBlobId(etag: string): string {
  return `tts.${etag}`;
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
