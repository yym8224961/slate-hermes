import { Injectable } from '@nestjs/common';
import { HistoryTodayConfig, type HistoryTodayConfigT } from 'shared';
import { AiService } from '../../ai/ai.service';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';

export interface HistoryTodayProviderData {
  /** "5月13日" */
  dateLabel: string;
  /** 5 行预格式化字符串："1492 · 哥伦布到达新大陆"；不够则后面为空串 */
  line0: string;
  line1: string;
  line2: string;
  line3: string;
  line4: string;
}

const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 86_400_000;
const RAW_LANG = 'zh-cn';

/**
 * 历史上的今天。
 *
 * 数据来源：维基百科中文 REST API
 * GET https://zh.wikipedia.org/api/rest_v1/feed/onthisday/events/{MM}/{DD}?variant=zh-cn
 * 请求简体变体。
 *
 * AI 优化是强约束：失败时抛错，renderer 只能保留旧 AI 数据，不能渲染 raw events。
 */
@Injectable()
export class HistoryTodayProvider implements DataProvider<
  HistoryTodayConfigT,
  HistoryTodayProviderData
> {
  readonly type = 'history_today';
  private readonly rawCache = new Map<
    string,
    { events: Array<{ year: number; text: string }>; fetchedAt: number }
  >();
  private readonly aiCache = new Map<
    string,
    { data: HistoryTodayProviderData; fetchedAt: number }
  >();
  private readonly inflight = new Map<string, Promise<HistoryTodayProviderData>>();

  constructor(private readonly ai: AiService) {}

  validateConfig(raw: unknown): HistoryTodayConfigT {
    return HistoryTodayConfig.parse(raw);
  }

  async fetchData(
    config: HistoryTodayConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<HistoryTodayProviderData> {
    const tz = config.tz;
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      month: 'numeric',
      day: 'numeric',
    });
    const parts = fmt.formatToParts(ctx.now);
    const month = parseInt(parts.find((p) => p.type === 'month')!.value, 10);
    const day = parseInt(parts.find((p) => p.type === 'day')!.value, 10);
    const rawKey = `${mmdd(month, day)}:${RAW_LANG}`;
    const aiKey = `${rawKey}:${this.ai.modelKey()}:${this.ai.historyTodayPromptVersion()}`;
    const nowMs = ctx.now.getTime();
    const cached = this.aiCache.get(aiKey);
    if (cached && nowMs - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
    if (cached) this.aiCache.delete(aiKey);

    const existing = this.inflight.get(aiKey);
    if (existing) return existing;

    const p = this.fetchOptimized(month, day, rawKey)
      .then((data) => {
        this.aiCache.set(aiKey, { data, fetchedAt: nowMs });
        return data;
      })
      .finally(() => this.inflight.delete(aiKey));
    this.inflight.set(aiKey, p);
    return p;
  }

  private async fetchOptimized(
    month: number,
    day: number,
    rawKey: string
  ): Promise<HistoryTodayProviderData> {
    const cachedRaw = this.rawCache.get(rawKey);
    const nowMs = Date.now();
    const events =
      cachedRaw && nowMs - cachedRaw.fetchedAt < CACHE_TTL_MS
        ? cachedRaw.events
        : await this.fetchRawEvents(month, day);
    if (!cachedRaw || nowMs - cachedRaw.fetchedAt >= CACHE_TTL_MS) {
      this.rawCache.set(rawKey, { events, fetchedAt: nowMs });
    }
    const dateLabel = `${month}月${day}日`;
    const aiData = await this.ai.optimizeHistoryToday({
      dateLabel,
      events,
    });
    if (!aiData) {
      throw new Error('history_today AI 优化失败');
    }
    return aiData;
  }

  private async fetchRawEvents(
    month: number,
    day: number
  ): Promise<Array<{ year: number; text: string }>> {
    const url = `https://zh.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}?variant=zh-cn`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`history HTTP ${resp.status}`);
      const json = (await resp.json()) as {
        events?: Array<{ year?: number; text?: string }>;
      };
      const evs = json.events ?? [];
      return evs
        .filter((event): event is { year: number; text: string } => {
          return typeof event.year === 'number' && typeof event.text === 'string' && !!event.text;
        })
        .map((event) => ({ year: event.year, text: event.text }));
    } finally {
      clearTimeout(timer);
    }
  }
}

function mmdd(month: number, day: number): string {
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
