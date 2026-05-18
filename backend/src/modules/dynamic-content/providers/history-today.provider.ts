import { Injectable } from '@nestjs/common';
import { HistoryTodayConfig, type HistoryTodayConfigT } from 'shared';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';

export interface HistoryTodayProviderData {
  /** "5 月 13 日" */
  dateLabel: string;
  /** 4 行预格式化字符串："1492 · 哥伦布到达新大陆"；不够则后面为空串 */
  line0: string;
  line1: string;
  line2: string;
  line3: string;
}

const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 86_400_000;
const MAX_EVENTS = 4;
const MAX_TEXT_LEN = 84;

/**
 * 历史上的今天。
 *
 * 数据来源：维基百科中文 REST API
 * GET https://zh.wikipedia.org/api/rest_v1/feed/onthisday/events/{MM}/{DD}
 * 返回原生中文，无需翻译，text 截短 70 字。
 *
 * 失败回退由 renderer 处理：抛错 → 用 lastData 或占位渲染。
 */
@Injectable()
export class HistoryTodayProvider implements DataProvider<
  HistoryTodayConfigT,
  HistoryTodayProviderData
> {
  readonly type = 'history_today';
  private readonly cache = new Map<string, { data: HistoryTodayProviderData; fetchedAt: number }>();
  private readonly inflight = new Map<string, Promise<HistoryTodayProviderData>>();

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
    const key = `${tz}:${month}:${day}`;
    const nowMs = Date.now();
    const cached = this.cache.get(key);
    if (cached && nowMs - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
    if (cached) this.cache.delete(key);

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = this.fetchFromWikipedia(month, day)
      .then((data) => {
        this.cache.set(key, { data, fetchedAt: Date.now() });
        return data;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async fetchFromWikipedia(month: number, day: number): Promise<HistoryTodayProviderData> {
    const url = `https://zh.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`history HTTP ${resp.status}`);
      const json = (await resp.json()) as {
        events?: Array<{ year?: number; text?: string }>;
      };
      const evs = json.events ?? [];
      // 选 4 条「年份均匀分布」的事件，兼顾信息量与 400x300 可读性。
      const lines: string[] = [];
      const idxs =
        evs.length <= MAX_EVENTS
          ? evs.map((_, i) => i)
          : [0, Math.floor(evs.length / 3), Math.floor((evs.length * 2) / 3), evs.length - 1];
      for (const i of idxs) {
        const e = evs[i];
        if (!e?.text || !e.year) continue;
        const text =
          e.text.length > MAX_TEXT_LEN ? `${e.text.slice(0, MAX_TEXT_LEN - 1)}…` : e.text;
        lines.push(`${e.year} · ${text}`);
      }
      while (lines.length < MAX_EVENTS) lines.push('');
      const dateLabel = `${month} 月 ${day} 日`;
      return {
        dateLabel,
        line0: lines[0]!,
        line1: lines[1]!,
        line2: lines[2]!,
        line3: lines[3]!,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
