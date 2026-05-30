import { Injectable } from '@nestjs/common';
import {
  normalizeWeatherAlertProvince,
  WeatherAlertConfig,
  type WeatherAlertConfigT,
} from 'shared';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';
import { stripHtml } from '../../../common/utils/html-text';
import { fetchJson } from '../../../common/http/fetch';
import {
  CachedInflightFetcher,
  DEFAULT_PROVIDER_CACHE_TTL_SEC,
  DEFAULT_PROVIDER_FETCH_TIMEOUT_MS,
} from './provider-cache';

export interface WeatherAlertItem {
  id: string;
  title: string;
  issuedAt: string;
  url?: string;
}

export interface WeatherAlertProviderData {
  title: string;
  province: string;
  updatedAt: string;
  items: WeatherAlertItem[];
}

interface WeatherAlertResponse {
  data?: {
    page?: {
      list?: Array<{
        alertid?: unknown;
        title?: unknown;
        issuetime?: unknown;
        url?: unknown;
      }>;
    };
  };
}

const NMC_ALARM_API = 'https://www.nmc.cn/rest/findAlarm';
const NMC_BASE_URL = 'https://www.nmc.cn';
const MAX_CACHE_ENTRIES = 128;

@Injectable()
export class WeatherAlertProvider implements DataProvider<
  WeatherAlertConfigT,
  WeatherAlertProviderData
> {
  readonly type = 'weather_alert';
  private readonly fetcher = new CachedInflightFetcher<string, WeatherAlertProviderData>(
    MAX_CACHE_ENTRIES
  );

  validateConfig(raw: unknown): WeatherAlertConfigT {
    return WeatherAlertConfig.parse(raw);
  }

  async fetchData(
    config: WeatherAlertConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<WeatherAlertProviderData> {
    const province = normalizeWeatherAlertProvince(config.province);
    const key = province || '全国';
    const now = ctx.now.getTime();
    const ttlMs =
      Math.max(config.refresh_interval_sec ?? DEFAULT_PROVIDER_CACHE_TTL_SEC, 300) * 1000;
    return this.fetcher.getOrFetch(key, now, ttlMs, () => this.fetchFresh(province, ctx));
  }

  private async fetchFresh(
    province: string,
    ctx: DynamicContentFetchCtx
  ): Promise<WeatherAlertProviderData> {
    const url =
      `${NMC_ALARM_API}?pageNo=1&pageSize=20&signaltype=&signallevel=&province=` +
      encodeURIComponent(province);
    const json = await fetchJson<WeatherAlertResponse>(url, {
      timeoutMs: DEFAULT_PROVIDER_FETCH_TIMEOUT_MS,
      headers: { Referer: 'https://www.nmc.cn/publish/alarm.html' },
    });
    const rows = json.data?.page?.list ?? [];
    const items = rows
      .flatMap((row, index): WeatherAlertItem[] => {
        const title = stripHtml(row.title);
        if (!title) return [];
        const href = stripHtml(row.url);
        const item: WeatherAlertItem = {
          id: stripHtml(row.alertid) || `${title}:${index}`,
          title,
          issuedAt: stripHtml(row.issuetime) || ctx.now.toISOString(),
        };
        if (href) {
          const url = safeNmcUrl(href);
          if (url) item.url = url;
        }
        return [item];
      })
      .slice(0, 20);

    return {
      title: `${province || '全国'}气象预警`,
      province,
      updatedAt: ctx.now.toISOString(),
      items,
    };
  }
}

function safeNmcUrl(href: string): string | undefined {
  try {
    const url = new URL(href, NMC_BASE_URL);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.hostname !== 'www.nmc.cn') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
