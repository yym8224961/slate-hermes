import { Injectable } from '@nestjs/common';
import { EarthquakeReportConfig, type EarthquakeReportConfigT } from 'shared';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';
import { stripHtml } from '../html-text';
import { fetchText } from '../../../common/http/fetch';

export interface EarthquakeReportItem {
  id: string;
  occurredAt: string;
  longitude: string;
  latitude: string;
  depthKm: string;
  magnitude: string;
  location: string;
  eventType: string;
}

export interface EarthquakeReportProviderData {
  title: string;
  updatedAt: string;
  sourceUrl: string;
  items: EarthquakeReportItem[];
}

interface CacheEntry {
  data: EarthquakeReportProviderData;
  fetchedAt: number;
}

const DEFAULT_CACHE_TTL_SEC = 600;
const FETCH_TIMEOUT_MS = 5000;
const SOURCE_URL = 'https://data.earthquake.cn/datashare/report.shtml?PAGEID=earthquake_subao';

@Injectable()
export class EarthquakeReportProvider implements DataProvider<
  EarthquakeReportConfigT,
  EarthquakeReportProviderData
> {
  readonly type = 'earthquake_report';
  private cache: CacheEntry | null = null;
  private inflight: Promise<EarthquakeReportProviderData> | null = null;

  validateConfig(raw: unknown): EarthquakeReportConfigT {
    return EarthquakeReportConfig.parse(raw);
  }

  async fetchData(
    config: EarthquakeReportConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<EarthquakeReportProviderData> {
    const now = ctx.now.getTime();
    const ttlMs = Math.max(config.refresh_interval_sec ?? DEFAULT_CACHE_TTL_SEC, 300) * 1000;
    if (this.inflight) return this.inflight;

    if (this.cache && now - this.cache.fetchedAt < ttlMs) return this.cache.data;
    if (this.cache) this.cache = null;

    const p = this.fetchFresh(ctx)
      .then((data) => {
        this.cache = { data, fetchedAt: now };
        return data;
      })
      .finally(() => {
        this.inflight = null;
      });
    this.inflight = p;
    return p;
  }

  private async fetchFresh(ctx: DynamicContentFetchCtx): Promise<EarthquakeReportProviderData> {
    const html = await fetchText(SOURCE_URL, { timeoutMs: FETCH_TIMEOUT_MS });
    const items = parseEarthquakeSubaoRows(html).slice(0, 20);
    if (items.length === 0 && !hasExpectedEarthquakeMarkup(html)) {
      throw new Error('地震速报页面结构已变化，无法解析列表');
    }
    return {
      title: '中国地震台网速报',
      updatedAt: ctx.now.toISOString(),
      sourceUrl: SOURCE_URL,
      items,
    };
  }
}

function hasExpectedEarthquakeMarkup(html: string): boolean {
  return (
    html.includes('earthquake_subao_guid_catalog') ||
    html.includes('cls-data-content-list') ||
    html.includes('earthquake_subao')
  );
}

export function parseEarthquakeSubaoRows(html: string): EarthquakeReportItem[] {
  const rows = html.match(/<tr id="earthquake_subao_guid_catalog_tr_\d+"[\s\S]*?<\/tr>/g) ?? [];
  return rows
    .map((row, index) => {
      const cells = [
        ...row.matchAll(/<div[^>]*class=['"]cls-data-content-list['"][^>]*>([\s\S]*?)<\/div>/g),
      ].map((match) => stripHtml(match[1] ?? ''));
      if (cells.length < 8) return null;
      const [sequence, occurredAt, longitude, latitude, depthKm, magnitude, location, eventType] =
        cells;
      if (!occurredAt || !location || !magnitude) return null;
      return {
        id: sequence || `${occurredAt}:${longitude}:${latitude}:${index}`,
        occurredAt,
        longitude,
        latitude,
        depthKm,
        magnitude,
        location,
        eventType,
      };
    })
    .filter((item): item is EarthquakeReportItem => item !== null);
}
