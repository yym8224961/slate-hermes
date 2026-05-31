import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  HotListSourceId,
  HotListConfig,
  hotListSourceLabel,
  normalizeHotListSourceId,
  type HotListConfigT,
  type CurrentHotListSourceIdT,
} from 'shared';
import { z } from 'zod';
import type {
  DataProvider,
  DynamicContentFetchCtx,
} from '../dynamic-content/dynamic-content.types';
import { HOT_LIST_SOURCE_REGISTRY } from './hot-list-source-registry';
import type { HotListItem, HotListProviderData, HotListSource } from './hot-list.types';
import { withRanks } from './hot-list.utils';
import {
  DEFAULT_PROVIDER_CACHE_TTL_SEC,
  DEFAULT_PROVIDER_FETCH_TIMEOUT_MS,
  isRecentTimestamp,
} from '../dynamic-content/providers/provider-cache';

interface CacheEntry {
  data: HotListProviderData;
  fetchedAt: number;
}

interface FetchFreshResult {
  sourceId: CurrentHotListSourceIdT;
  sourceLabel: string;
  items: HotListItem[];
}

/** 测试通过构造函数注入 mock sources；生产由 NestJS 走 @Optional 走默认值。 */
export const HOT_LIST_SOURCES_TOKEN = Symbol('HotListSources');

@Injectable()
export class HotListProvider implements DataProvider<HotListConfigT, HotListProviderData> {
  readonly type = 'hot_list';
  private readonly logger = new Logger(HotListProvider.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<FetchFreshResult>>();
  private readonly sources: readonly HotListSource[];

  constructor(@Optional() @Inject(HOT_LIST_SOURCES_TOKEN) sources?: readonly HotListSource[]) {
    this.sources = sources ?? HOT_LIST_SOURCE_REGISTRY;
  }

  validateConfig(raw: unknown): HotListConfigT {
    return HotListConfig.parse(raw);
  }

  /**
   * 与 WeatherProvider 的差异：weather 用「共享 promise」让并发 caller 拿到同一份数据；
   * hot-list 不共享 promise，而是让每个 caller 自行调用 dataFromFreshResult，从而在
   * fetch 失败时各自回退到自己的 lastData。原因：同一个 source（如 weibo）会被多个
   * Content 引用，它们的 lastData 各不相同，不能复用一份共享 fallback。
   */
  async fetchData(
    config: HotListConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<HotListProviderData> {
    const key = config.source;
    const now = ctx.now.getTime();
    const ttlMs =
      Math.max(config.refresh_interval_sec ?? DEFAULT_PROVIDER_CACHE_TTL_SEC, 300) * 1000;
    const cached = this.cache.get(key);
    if (cached && now - cached.fetchedAt < ttlMs) return cached.data;
    if (cached) this.cache.delete(key);

    const existing = this.inflight.get(key);
    if (existing) {
      const fresh = await existing.catch(() => null);
      return this.dataFromFreshResult(fresh, config, ctx);
    }

    const p = this.fetchFresh(config.source).catch((err: unknown) => {
      this.logger.warn(
        `hot-list source fetch failed source=${config.source}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      throw err;
    });
    this.inflight.set(key, p);
    let fresh: FetchFreshResult | null;
    try {
      fresh = await p.catch(() => null);
    } finally {
      this.inflight.delete(key);
    }

    const data = this.dataFromFreshResult(fresh, config, ctx);
    if (fresh && fresh.items.length > 0) {
      this.cache.set(key, { data, fetchedAt: now });
    }
    return data;
  }

  private dataFromFreshResult(
    fresh: FetchFreshResult | null,
    config: HotListConfigT,
    ctx: DynamicContentFetchCtx
  ): HotListProviderData {
    if (fresh && fresh.items.length > 0) {
      return {
        source: fresh.sourceId,
        sourceLabel: fresh.sourceLabel,
        updatedAt: ctx.now.toISOString(),
        items: fresh.items,
      };
    }

    const fallback = this.fallbackFromLastData(config, ctx.lastData, ctx.now);
    if (fallback) return fallback;
    return this.emptyData(config.source, ctx.now);
  }

  private async fetchFresh(sourceId: CurrentHotListSourceIdT): Promise<FetchFreshResult> {
    const source = this.sources.find((s) => s.id === sourceId);
    if (!source) throw new Error(`未知热榜数据源: ${sourceId}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_PROVIDER_FETCH_TIMEOUT_MS);
    try {
      const items = withRanks(await source.fetch({ signal: controller.signal })).slice(0, 30);
      return {
        sourceId: source.id,
        sourceLabel: source.label || hotListSourceLabel(source.id),
        items,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private fallbackFromLastData(
    config: HotListConfigT,
    lastData: unknown,
    now: Date
  ): HotListProviderData | null {
    const parsed = HotListProviderDataFallback.safeParse(lastData);
    if (!parsed.success) return null;
    const data = parsed.data;
    const source = HotListSourceId.safeParse(data.source);
    if (!source.success || !Array.isArray(data.items) || data.items.length === 0) return null;
    if (!isRecentTimestamp(data.updatedAt, now, reusableHotListAgeMs(config))) return null;
    const normalizedSource = normalizeHotListSourceId(source.data);
    return {
      source: normalizedSource,
      sourceLabel: data.sourceLabel ?? hotListSourceLabel(normalizedSource),
      updatedAt: data.updatedAt ?? new Date().toISOString(),
      items: withRanks(data.items),
    };
  }

  private emptyData(sourceId: CurrentHotListSourceIdT, now: Date): HotListProviderData {
    return {
      source: sourceId,
      sourceLabel: hotListSourceLabel(sourceId),
      updatedAt: now.toISOString(),
      items: [],
    };
  }
}

function reusableHotListAgeMs(config: HotListConfigT): number {
  const ttlSec = Math.max(config.refresh_interval_sec ?? DEFAULT_PROVIDER_CACHE_TTL_SEC, 300);
  return Math.min(Math.max(ttlSec * 3, 900), 3_600) * 1000;
}

const HotListItemFallback = z.object({
  rank: z.number(),
  title: z.string(),
  hot: z.string().optional(),
  desc: z.string().optional(),
  author: z.string().optional(),
  url: z.string().optional(),
  timestamp: z.string().optional(),
});

const HotListProviderDataFallback = z.object({
  source: HotListSourceId,
  sourceLabel: z.string().optional(),
  updatedAt: z.string(),
  items: z.array(HotListItemFallback),
});
