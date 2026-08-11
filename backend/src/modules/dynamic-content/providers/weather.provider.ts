import { Injectable } from '@nestjs/common';
import { WeatherConfig, type WeatherConfigT } from 'shared';
import { z } from 'zod';
import { fetchJson as fetchJsonWithTimeout } from '../../../common/http/fetch';
import { getDateTimeFormat } from '../../../common/utils/intl';
import { setBoundedCache } from '../../../common/utils/cache-utils';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';
import { datePartsInTz } from '../timezone';
import {
  CachedInflightFetcher,
  DEFAULT_PROVIDER_CACHE_TTL_SEC,
  DEFAULT_PROVIDER_FETCH_TIMEOUT_MS,
  isRecentTimestamp,
} from './provider-cache';
import { QweatherConfig } from './qweather.config';

export interface WeatherForecastDay {
  label: string;
  val: string;
  text: string;
  tempMin: number | string;
  tempMax: number | string;
  code: number;
}

export interface WeatherProviderData {
  tempC: number | string;
  feelsLikeC: number | string;
  humidity: number | string;
  pressure: number | string;
  windDisplay: string;
  summary: string;
  code: number;
  obsTime: string;
  updatedAt: string;
  fc: WeatherForecastDay[];
}

interface LookupCacheEntry {
  id: string;
  fetchedAt: number;
}

interface QWeatherNowResponse {
  code?: string;
  updateTime?: string;
  now?: {
    obsTime?: string;
    temp?: string;
    feelsLike?: string;
    text?: string;
    icon?: string;
    windDir?: string;
    windScale?: string;
    windSpeed?: string;
    humidity?: string;
    pressure?: string;
  };
}

interface QWeatherForecastResponse {
  code?: string;
  updateTime?: string;
  daily?: Array<{
    fxDate?: string;
    tempMax?: string;
    tempMin?: string;
    textDay?: string;
    textNight?: string;
    iconDay?: string;
  }>;
}

interface QWeatherCityLookupResponse {
  code?: string;
  location?: Array<{
    id?: string;
    name?: string;
    adm1?: string;
    adm2?: string;
  }>;
}

interface WttrResponse {
  current_condition?: Array<{
    temp_C?: string;
    FeelsLikeC?: string;
    humidity?: string;
    pressure?: string;
    winddir16Point?: string;
    windspeedKmph?: string;
    weatherCode?: string;
    weatherDesc?: Array<{ value?: string }>;
  }>;
  weather?: Array<{
    date?: string;
    maxtempC?: string;
    mintempC?: string;
    hourly?: Array<{
      time?: string;
      weatherCode?: string;
      weatherDesc?: Array<{ value?: string }>;
    }>;
  }>;
}

export interface WeatherCitySearchResult {
  id: string;
  name: string;
  adm1: string;
  adm2: string;
}

const LOOKUP_CACHE_TTL_MS = 86_400_000;
const CITY_SEARCH_CACHE_TTL_MS = 3_600_000;
const FC_LABELS = ['今日', '明日', '后天'];
const WTTR_BASE_URL = 'https://wttr.in';
const WTTR_USER_AGENT = 'Slate/0.1 (+https://github.com/yym8224961/slate-hermes; weather-fallback)';
const MAX_CACHE_ENTRIES = 128;
const MAX_LOOKUP_CACHE_ENTRIES = 256;
const MAX_CITY_SEARCH_CACHE_ENTRIES = 128;

@Injectable()
export class WeatherProvider implements DataProvider<WeatherConfigT, WeatherProviderData> {
  readonly type = 'weather';
  private readonly fetcher = new CachedInflightFetcher<string, WeatherProviderData>(
    MAX_CACHE_ENTRIES
  );
  private readonly lookupCache = new Map<string, LookupCacheEntry>();
  private readonly lookupInflight = new Map<string, Promise<string>>();
  private readonly citySearchCache = new Map<
    string,
    { data: WeatherCitySearchResult[]; fetchedAt: number }
  >();
  private readonly citySearchInflight = new Map<string, Promise<WeatherCitySearchResult[]>>();

  constructor(private readonly config: QweatherConfig) {}

  validateConfig(raw: unknown): WeatherConfigT {
    return WeatherConfig.parse(raw);
  }

  async searchCities(
    query: string,
    limit = 8,
    now = Date.now()
  ): Promise<WeatherCitySearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    const apiKey = this.config.apiKey;
    if (!apiKey || !this.config.apiHost) return [];

    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);
    const key = `${normalizedQuery}:${safeLimit}`;
    const cached = this.citySearchCache.get(key);
    if (cached && now - cached.fetchedAt < CITY_SEARCH_CACHE_TTL_MS) return cached.data;
    if (cached) this.citySearchCache.delete(key);

    const existing = this.citySearchInflight.get(key);
    if (existing) return existing;

    const host = this.config.apiHost.replace(/\/+$/, '');
    const p = this.fetchCitySearch(host, apiKey, normalizedQuery, safeLimit)
      .then((data) => {
        setBoundedCache(
          this.citySearchCache,
          key,
          { data, fetchedAt: now },
          MAX_CITY_SEARCH_CACHE_ENTRIES
        );
        return data;
      })
      .finally(() => this.citySearchInflight.delete(key));
    this.citySearchInflight.set(key, p);
    return p;
  }

  private cacheKey(c: WeatherConfigT): string {
    return `${c.provider}:${c.location_id}:${c.tz}`;
  }

  async fetchData(
    config: WeatherConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<WeatherProviderData> {
    const key = this.cacheKey(config);
    const now = ctx.now.getTime();
    const ttlSec = Math.max(config.refresh_interval_sec ?? DEFAULT_PROVIDER_CACHE_TTL_SEC, 300);
    return this.fetcher.getOrFetch(key, now, ttlSec * 1000, () =>
      this.fetchWithFallback(config, ctx)
    );
  }

  private async fetchWithFallback(
    config: WeatherConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<WeatherProviderData> {
    let qweatherError: unknown = null;
    if (this.config.apiKey && this.config.apiHost) {
      try {
        return await this.fetchFromQWeather(config, ctx);
      } catch (err: unknown) {
        qweatherError = err;
      }
    }

    try {
      return await this.fetchFromWttr(config, ctx);
    } catch (fallbackError: unknown) {
      const cached = this.fallbackFromLastData(config, ctx.lastData, ctx.now);
      if (cached) return cached;
      throw qweatherError ?? fallbackError;
    }
  }

  private async fetchFromWttr(
    config: WeatherConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<WeatherProviderData> {
    const location = encodeURIComponent(config.location_label.trim());
    const url = `${WTTR_BASE_URL}/${location}?format=j1`;
    const json = await fetchJsonWithTimeout<WttrResponse>(url, {
      timeoutMs: DEFAULT_PROVIDER_FETCH_TIMEOUT_MS,
      userAgent: WTTR_USER_AGENT,
    });
    const current = json.current_condition?.[0];
    const forecast = json.weather?.slice(0, 3) ?? [];
    if (!current || forecast.length === 0) throw new Error('公共天气源没有返回有效数据');

    const fc = forecast.map((day, index) => {
      const hourly = pickWttrForecastHour(day.hourly);
      const code = mapWttrCode(hourly?.weatherCode);
      const text = weatherText(hourly?.weatherCode, hourly?.weatherDesc?.[0]?.value);
      const tempMin = toDisplayNumber(day.mintempC);
      const tempMax = toDisplayNumber(day.maxtempC);
      return {
        label: forecastLabel(day.date, config.tz, ctx.now) ?? FC_LABELS[index] ?? '--',
        val: `${text}  ${tempMin}~${tempMax}°`,
        text,
        tempMin,
        tempMax,
        code,
      };
    });

    const currentCode = mapWttrCode(current.weatherCode);
    const currentText = weatherText(current.weatherCode, current.weatherDesc?.[0]?.value);
    const windSpeed = toDisplayNumber(current.windspeedKmph);
    return {
      tempC: toDisplayNumber(current.temp_C),
      feelsLikeC: toDisplayNumber(current.FeelsLikeC),
      humidity: toDisplayNumber(current.humidity),
      pressure: toDisplayNumber(current.pressure),
      windDisplay: current.winddir16Point
        ? `${translateWindDirection(current.winddir16Point)}${windSpeed === '--' ? '' : ` ${windSpeed}km/h`}`
        : windSpeed === '--'
          ? '--'
          : `${windSpeed}km/h`,
      summary: currentText,
      code: currentCode,
      obsTime: ctx.now.toISOString(),
      updatedAt: ctx.now.toISOString(),
      fc,
    };
  }

  private async fetchFromQWeather(
    config: WeatherConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<WeatherProviderData> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      const fallback = this.fallbackFromLastData(config, ctx.lastData, ctx.now);
      if (fallback) return fallback;
      throw new Error('QWEATHER_API_KEY 未配置');
    }
    if (!this.config.apiHost) {
      const fallback = this.fallbackFromLastData(config, ctx.lastData, ctx.now);
      if (fallback) return fallback;
      throw new Error('QWEATHER_API_HOST 未配置，请在和风天气控制台-设置中复制你的 API Host');
    }

    const host = this.config.apiHost.replace(/\/+$/, '');
    const locationId = await this.resolveLocationId(
      host,
      apiKey,
      config.location_id,
      ctx.now.getTime()
    );
    const location = encodeURIComponent(locationId);
    const lang = 'zh';
    const nowUrl = `${host}/v7/weather/now?location=${location}&lang=${lang}&unit=m`;
    const forecastUrl = `${host}/v7/weather/3d?location=${location}&lang=${lang}&unit=m`;

    const [nowJson, forecastJson] = await Promise.all([
      fetchJson<QWeatherNowResponse>(nowUrl, apiKey),
      fetchJson<QWeatherForecastResponse>(forecastUrl, apiKey),
    ]);

    if (nowJson.code !== '200') throw new Error(`QWeather now code ${nowJson.code ?? 'unknown'}`);
    if (forecastJson.code !== '200')
      throw new Error(`QWeather forecast code ${forecastJson.code ?? 'unknown'}`);

    const nowData = nowJson.now ?? {};
    const windSpeed = toDisplayNumber(nowData.windSpeed);
    const fc =
      forecastJson.daily?.slice(0, 3).map((day, index) => {
        const dayText = day.textDay || day.textNight || '--';
        const night = day.textNight && day.textNight !== dayText ? `/${day.textNight}` : '';
        const tempMin = toDisplayNumber(day.tempMin);
        const tempMax = toDisplayNumber(day.tempMax);
        return {
          label: forecastLabel(day.fxDate, config.tz, ctx.now) ?? FC_LABELS[index] ?? '--',
          val: `${dayText}${night}  ${tempMin}~${tempMax}°`,
          text: `${dayText}${night}`,
          tempMin,
          tempMax,
          code: Number.parseInt(day.iconDay ?? '999', 10),
        };
      }) ?? [];

    while (fc.length < 3) {
      fc.push({
        label: FC_LABELS[fc.length]!,
        val: '--',
        text: '--',
        tempMin: '--',
        tempMax: '--',
        code: 999,
      });
    }

    return {
      tempC: toDisplayNumber(nowData.temp),
      feelsLikeC: toDisplayNumber(nowData.feelsLike),
      humidity: toDisplayNumber(nowData.humidity),
      pressure: toDisplayNumber(nowData.pressure),
      windDisplay: nowData.windDir
        ? `${nowData.windDir}${nowData.windScale ? nowData.windScale + '级' : ''}`
        : windSpeed === '--'
          ? '--'
          : `${windSpeed}km/h`,
      summary: nowData.text || '--',
      code: Number.parseInt(nowData.icon ?? forecastJson.daily?.[0]?.iconDay ?? '999', 10),
      obsTime: nowData.obsTime || nowJson.updateTime || ctx.now.toISOString(),
      updatedAt: nowJson.updateTime || ctx.now.toISOString(),
      fc,
    };
  }

  private async resolveLocationId(
    host: string,
    apiKey: string,
    locationId: string,
    now: number
  ): Promise<string> {
    if (/^\d+$/.test(locationId)) return locationId;
    const cached = this.lookupCache.get(locationId);
    if (cached && now - cached.fetchedAt < LOOKUP_CACHE_TTL_MS) return cached.id;
    if (cached) this.lookupCache.delete(locationId);

    const existing = this.lookupInflight.get(locationId);
    if (existing) return existing;

    const p = this.fetchLocationId(host, apiKey, locationId)
      .then((id) => {
        setBoundedCache(
          this.lookupCache,
          locationId,
          { id, fetchedAt: now },
          MAX_LOOKUP_CACHE_ENTRIES
        );
        return id;
      })
      .finally(() => this.lookupInflight.delete(locationId));
    this.lookupInflight.set(locationId, p);
    return p;
  }

  private async fetchLocationId(host: string, apiKey: string, locationId: string): Promise<string> {
    const url =
      `${host}/geo/v2/city/lookup?location=${encodeURIComponent(locationId)}` +
      `&range=cn&number=1&lang=zh`;
    const json = await fetchJson<QWeatherCityLookupResponse>(url, apiKey);
    if (json.code !== '200') throw new Error(`QWeather city lookup code ${json.code ?? 'unknown'}`);
    const id = json.location?.[0]?.id;
    if (!id) throw new Error(`QWeather city lookup empty: ${locationId}`);
    return id;
  }

  private async fetchCitySearch(
    host: string,
    apiKey: string,
    query: string,
    limit: number
  ): Promise<WeatherCitySearchResult[]> {
    const url =
      `${host}/geo/v2/city/lookup?location=${encodeURIComponent(query)}` +
      `&range=cn&number=${limit}&lang=zh`;
    const json = await fetchJson<QWeatherCityLookupResponse>(url, apiKey);
    if (json.code !== '200') throw new Error(`QWeather city lookup code ${json.code ?? 'unknown'}`);
    return (json.location ?? [])
      .map((location) => ({
        id: location.id?.trim() ?? '',
        name: location.name?.trim() ?? '',
        adm1: location.adm1?.trim() ?? '',
        adm2: location.adm2?.trim() ?? '',
      }))
      .filter((location) => location.id && location.name);
  }

  private fallbackFromLastData(
    config: WeatherConfigT,
    lastData: unknown,
    now: Date
  ): WeatherProviderData | null {
    const parsed = WeatherProviderDataFallback.safeParse(lastData);
    if (!parsed.success) return null;
    const data = parsed.data;
    if (!data.summary && data.tempC === undefined) return null;
    if (!isRecentTimestamp(data.updatedAt, now, reusableWeatherAgeMs(config))) return null;
    return {
      tempC: data.tempC ?? '--',
      feelsLikeC: data.feelsLikeC ?? '--',
      humidity: data.humidity ?? '--',
      pressure: data.pressure ?? '--',
      windDisplay: data.windDisplay ?? '--',
      summary: data.summary ?? '--',
      code: typeof data.code === 'number' ? data.code : 999,
      obsTime: data.obsTime ?? now.toISOString(),
      updatedAt: data.updatedAt ?? now.toISOString(),
      fc: Array.isArray(data.fc) ? data.fc.slice(0, 3) : [],
    };
  }
}

function reusableWeatherAgeMs(config: WeatherConfigT): number {
  const ttlSec = Math.max(config.refresh_interval_sec ?? DEFAULT_PROVIDER_CACHE_TTL_SEC, 300);
  return Math.min(Math.max(ttlSec * 3, 900), 43_200) * 1000;
}

async function fetchJson<T>(url: string, apiKey: string): Promise<T> {
  return fetchJsonWithTimeout<T>(url, {
    timeoutMs: DEFAULT_PROVIDER_FETCH_TIMEOUT_MS,
    headers: { 'X-QW-Api-Key': apiKey },
    userAgent: null,
  });
}

const WeatherForecastDayFallback = z.object({
  label: z.string(),
  val: z.string(),
  text: z.string(),
  tempMin: z.union([z.number(), z.string()]),
  tempMax: z.union([z.number(), z.string()]),
  code: z.number(),
});

const WeatherProviderDataFallback = z.object({
  tempC: z.union([z.number(), z.string()]).optional(),
  feelsLikeC: z.union([z.number(), z.string()]).optional(),
  humidity: z.union([z.number(), z.string()]).optional(),
  pressure: z.union([z.number(), z.string()]).optional(),
  windDisplay: z.string().optional(),
  summary: z.string().optional(),
  code: z.number().optional(),
  obsTime: z.string().optional(),
  updatedAt: z.string().optional(),
  fc: z.array(WeatherForecastDayFallback).optional(),
});

function toDisplayNumber(value: unknown): number | string {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : value;
  }
  return '--';
}

export function forecastLabel(value: unknown, timeZone: string, now: Date): string | null {
  if (typeof value !== 'string' || !value) return '--';
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) return value.slice(5);
  const today = datePartsInTz(now, timeZone);
  if (today) {
    const delta = ordinalDay(year, month, day) - ordinalDay(today.year, today.month, today.day);
    if (delta >= 0 && delta < FC_LABELS.length) return FC_LABELS[delta]!;
  }
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (Number.isNaN(date.getTime())) return value.slice(5);
  try {
    return getDateTimeFormat('zh-CN', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
    }).format(date);
  } catch {
    return value.slice(5);
  }
}

function ordinalDay(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function pickWttrForecastHour(
  hours:
    | Array<{
        time?: string;
        weatherCode?: string;
        weatherDesc?: Array<{ value?: string }>;
      }>
    | undefined
) {
  if (!hours || hours.length === 0) return undefined;
  return (
    hours.find((hour) => hour.time === '1200') ?? hours[Math.floor(hours.length / 2)] ?? hours[0]
  );
}

function mapWttrCode(value: string | undefined): number {
  const code = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(code)) return 999;
  if (code === 113) return 100;
  if (code === 116) return 101;
  if (code === 119 || code === 122) return 104;
  if ([143, 248, 260].includes(code)) return 500;
  if ([176, 263, 266, 293, 296, 353].includes(code)) return 300;
  if ([299, 302, 305, 308, 356, 359, 386, 389].includes(code)) return 302;
  if ([323, 326, 368].includes(code)) return 400;
  if ([329, 332, 362].includes(code)) return 401;
  if ([335, 338, 365, 371, 392, 395].includes(code)) return 406;
  if ([350, 374, 377].includes(code)) return 499;
  return 999;
}

function weatherText(value: string | undefined, description: string | undefined): string {
  const code = Number.parseInt(value ?? '', 10);
  const known: Record<number, string> = {
    113: '晴',
    116: '多云',
    119: '阴',
    122: '阴',
    143: '雾',
    176: '阵雨',
    200: '雷阵雨',
    263: '小雨',
    266: '小雨',
    293: '小雨',
    296: '小雨',
    299: '中雨',
    302: '中雨',
    305: '大雨',
    308: '大雨',
    323: '小雪',
    326: '小雪',
    329: '中雪',
    332: '中雪',
    335: '大雪',
    338: '大雪',
    350: '冰雹',
    353: '阵雨',
    356: '暴雨',
    359: '暴雨',
    362: '雨夹雪',
    365: '雨夹雪',
    368: '阵雪',
    371: '暴雪',
    374: '冰雹',
    377: '冰雹',
    386: '雷阵雨',
    389: '雷阵雨',
    392: '雷阵雪',
    395: '雷阵雪',
  };
  return known[code] ?? (description?.trim() ? normalizeWeatherDescription(description) : '--');
}

function normalizeWeatherDescription(value: string): string {
  return value
    .replace(/patchy\s+rain\s+nearby/i, '阵雨')
    .replace(/partly\s+cloudy/i, '多云')
    .replace(/sunny/i, '晴')
    .replace(/cloudy|overcast/i, '阴')
    .replace(/light\s+rain/i, '小雨')
    .replace(/moderate\s+rain/i, '中雨')
    .replace(/heavy\s+rain/i, '大雨');
}

function translateWindDirection(value: string): string {
  const compact = value.trim().toUpperCase();
  const directions: Record<string, string> = {
    N: '北风',
    NE: '东北风',
    E: '东风',
    SE: '东南风',
    S: '南风',
    SW: '西南风',
    W: '西风',
    NW: '西北风',
  };
  return directions[compact] ?? value;
}
