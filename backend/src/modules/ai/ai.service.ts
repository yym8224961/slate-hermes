import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { fetchWithTimeout } from '../../common/http/fetch';
import { parseSsePayloads } from '../../common/http/sse';
import { AiConfig } from './ai.config';

const REQUEST_TIMEOUT_MS = 45_000;
const HISTORY_TODAY_PROMPT_VERSION = '2026-05-21.v5';
const MAX_AI_RESPONSE_BYTES = 512 * 1024;

const HistoryTodayOptimized = z.object({
  dateLabel: z.string().min(1).max(24),
  items: z
    .array(
      z.object({
        year: z.string().min(1).max(16),
        display: z.string().min(1).max(120),
      })
    )
    .min(1)
    .max(5),
});
export type HistoryTodayOptimizedT = z.infer<typeof HistoryTodayOptimized>;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
    delta?: {
      content?: string | null;
    };
  }>;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly config: AiConfig) {}

  enabled(): boolean {
    return !!this.config.apiKey && !!this.config.baseUrl;
  }

  modelKey(): string {
    return this.config.model;
  }

  historyTodayPromptVersion(): string {
    return HISTORY_TODAY_PROMPT_VERSION;
  }

  async optimizeHistoryToday(input: {
    dateLabel: string;
    events: Array<{
      year: number;
      yearLabel: string;
      text: string;
      pages?: Array<{ title: string; description?: string; extract?: string }>;
    }>;
  }): Promise<HistoryTodayOptimizedT | null> {
    if (!this.enabled()) return null;
    const content = await this.requestJson({
      system:
        '你是面向中国大陆用户的历史内容主编。只输出 JSON，不要 Markdown。内容用于 400x300 黑白墨水屏。',
      user: JSON.stringify({
        task: '从输入事件中按权重选出最多 5 条可展示事件，并改写为大陆简体中文墨水屏文案。',
        editorial_policy: [
          '按综合权重筛选，不要把“中国大陆相关”作为绝对优先。',
          '权重最高：对世界历史、科技、战争、制度、国际组织、文化有长期影响的事件。',
          '权重较高：中国大陆历史、政治、科技、文化、社会发展、重大灾害相关事件。',
          '权重中等：对中国整体历史进程有影响，但地域较窄或解释成本较高的事件。',
          '权重较低：地方性短期新闻、地区政治细节、娱乐八卦、普通人物出生逝世。',
          '在权重接近时，优先保留时间跨度更分散、主题更多样的事件。',
          '不要为了凑满 5 条选择低价值事件；但有 5 条可读事件时应尽量填满。',
        ],
        writing_rules: [
          '必须使用中国大陆常用简体中文、中文标点和大陆常用译名。',
          '将繁体、台湾地区用语、港澳台译名尽量改为大陆常用表达。',
          '只基于输入事件改写，不编造输入中没有的信息。',
          'year 优先原样使用输入事件的 yearLabel，不使用负数年份。',
          'display 不包含年份，不使用“历史上的今天”等标题。',
          'display 目标长度 28-40 个汉字；不要压缩成标题，尽量保留事件的对象、动作和结果。',
          '如果原始信息不足 28 字也不要硬编；但不要故意写得过短。',
          '表述克制、准确，不煽情，不标题党。',
        ],
        dateLabel: input.dateLabel,
        events: input.events.slice(0, 100),
        output_schema: {
          dateLabel: 'string',
          items: [
            {
              year: 'string, use "1904" or "前221"',
              display: 'string, simplified Chinese, no year, about 28-40 Chinese chars',
            },
          ],
        },
      }),
    });
    if (!content) return null;
    try {
      return HistoryTodayOptimized.parse(extractJsonObject(content));
    } catch (err) {
      this.logger.warn(
        `AI returned invalid history_today JSON with prompt version ${HISTORY_TODAY_PROMPT_VERSION}: ${formatShortError(err)}`
      );
      return null;
    }
  }

  private async requestJson(input: { system: string; user: string }): Promise<string | null> {
    const url = `${this.config.baseUrl!.replace(/\/+$/, '')}/chat/completions`;
    let body: string;
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' },
        }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new AiResponseError(
          `AI HTTP ${resp.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`
        );
      }
      body = await readResponseText(resp, MAX_AI_RESPONSE_BYTES);
    } catch (err) {
      if (!isRecoverableAiRequestError(err)) throw err;
      this.logger.warn(`AI request to model ${this.config.model} failed: ${formatShortError(err)}`);
      return null;
    }

    const content = parseChatCompletionContent(body);
    if (!content) {
      this.logger.warn(
        `AI request to model ${this.config.model} returned no usable content: ${truncateLogText(body, 240)}`
      );
      return null;
    }
    return content;
  }
}

class AiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiResponseError';
  }
}

function isRecoverableAiRequestError(err: unknown): boolean {
  if (err instanceof AiResponseError) return true;
  if (!(err instanceof Error)) return true;
  return err.name === 'AbortError' || err.name === 'TimeoutError' || err instanceof TypeError;
}

function formatShortError(err: unknown): string {
  return truncateLogText(err instanceof Error ? err.message : String(err), 512);
}

function truncateLogText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

async function readResponseText(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) return await resp.text();
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AiResponseError(`AI 响应超过 ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseChatCompletionContent(body: string): string | null {
  const text = body.trim();
  if (!text) return null;

  const direct = parseChatCompletionJson(text);
  if (direct) return direct;
  if (text.startsWith('{') || text.startsWith('[')) return text;

  if (text.includes('data:')) {
    const parts: string[] = [];
    for (const payload of parseSsePayloads(text)) {
      const chunk = parseChatCompletionJson(payload);
      if (chunk) parts.push(chunk);
    }
    const combined = parts.join('');
    if (combined.trim()) return combined;
  }

  return null;
}

function parseChatCompletionJson(text: string): string | null {
  try {
    const json = JSON.parse(text) as ChatCompletionResponse;
    const message = json.choices?.[0]?.message?.content;
    if (message && message.trim()) return message;
    const delta = json.choices?.map((choice) => choice.delta?.content ?? '').join('');
    return delta && delta.trim() ? delta : null;
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    for (const object of balancedJsonObjects(text)) {
      try {
        return JSON.parse(object);
      } catch {
        // Ignore non-JSON brace blocks such as examples in prose and keep scanning.
      }
    }
    throw new Error('AI 响应不是 JSON');
  }
}

function* balancedJsonObjects(text: string): Generator<string> {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (start < 0) {
      if (ch === '{') {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        yield text.slice(start, i + 1);
        start = -1;
        inString = false;
        escaped = false;
      }
    }
  }
}
