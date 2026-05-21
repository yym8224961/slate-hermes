import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../../infra/config/app.config';

const REQUEST_TIMEOUT_MS = 45_000;
const HISTORY_TODAY_PROMPT_VERSION = '2026-05-21.v1';

const HistoryTodayOptimized = z.object({
  dateLabel: z.string().min(1).max(24),
  line0: z.string().max(84),
  line1: z.string().max(84),
  line2: z.string().max(84),
  line3: z.string().max(84),
  line4: z.string().max(84),
});
export type HistoryTodayOptimizedT = z.infer<typeof HistoryTodayOptimized>;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly config: AppConfig) {}

  enabled(): boolean {
    return !!this.config.aiApiKey && !!this.config.aiBaseUrl;
  }

  modelKey(): string {
    return this.config.aiModel;
  }

  historyTodayPromptVersion(): string {
    return HISTORY_TODAY_PROMPT_VERSION;
  }

  async optimizeHistoryToday(input: {
    dateLabel: string;
    events: Array<{ year: number; text: string }>;
  }): Promise<HistoryTodayOptimizedT | null> {
    if (!this.enabled()) return null;
    const content = await this.requestJson({
      system:
        '你是嵌入式墨水屏内容编辑。只输出 JSON，不要 Markdown。筛选并改写历史事件，适合 400x300 中文点阵屏显示。',
      user: JSON.stringify({
        task: '从 events 中选 5 条信息密度高且互相有时间跨度的事件。每行格式必须是“年份 · 事件”，中文精炼，单行不超过 36 个汉字。',
        dateLabel: input.dateLabel,
        events: input.events.slice(0, 80),
        output_schema: {
          dateLabel: 'string',
          line0: 'string',
          line1: 'string',
          line2: 'string',
          line3: 'string',
          line4: 'string',
        },
      }),
    });
    if (!content) return null;
    try {
      return HistoryTodayOptimized.parse(extractJsonObject(content));
    } catch (err) {
      this.logger.warn(
        `AI history_today JSON invalid: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  private async requestJson(input: { system: string; user: string }): Promise<string | null> {
    const url = `${this.config.aiBaseUrl!.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.aiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.aiModel,
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
        throw new Error(`AI HTTP ${resp.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
      }
      const json = (await resp.json()) as ChatCompletionResponse;
      return json.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      this.logger.warn(`AI request failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
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
