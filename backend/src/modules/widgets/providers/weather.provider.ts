import { Injectable } from '@nestjs/common';
import { WeatherConfig, type WeatherConfigT } from 'shared';
import { AppConfig } from '../../../infra/config/app.config';
import type { DataProvider, WidgetFetchCtx } from '../widget-types';

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

interface CacheEntry {
  data: WeatherProviderData;
  fetchedAt: number;
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

const CACHE_TTL_MS = 600_000;
const LOOKUP_CACHE_TTL_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 5000;
const FC_LABELS = ['今日', '明日', '后天'];

@Injectable()
export class WeatherProvider implements DataProvider<WeatherConfigT, WeatherProviderData> {
  readonly type = 'weather';
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lookupCache = new Map<string, LookupCacheEntry>();
  private readonly lookupInflight = new Map<string, Promise<string>>();
  private readonly inflight = new Map<string, Promise<WeatherProviderData>>();

  constructor(private readonly config: AppConfig) {}

  validateConfig(raw: unknown): WeatherConfigT {
    return WeatherConfig.parse(raw);
  }

  private cacheKey(c: WeatherConfigT): string {
    return `${c.provider}:${c.location_id}:${c.units}:${c.tz}`;
  }

  async fetchData(config: WeatherConfigT, ctx: WidgetFetchCtx): Promise<WeatherProviderData> {
    const key = this.cacheKey(config);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
    if (cached) this.cache.delete(key);

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = this.fetchFromQWeather(config, ctx)
      .then((data) => {
        this.cache.set(key, { data, fetchedAt: Date.now() });
        return data;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async fetchFromQWeather(
    config: WeatherConfigT,
    ctx: WidgetFetchCtx
  ): Promise<WeatherProviderData> {
    const apiKey = this.config.qweatherApiKey;
    if (!apiKey) {
      const fallback = this.fallbackFromLastData(ctx.lastData);
      if (fallback) return fallback;
      throw new Error('QWEATHER_API_KEY 未配置');
    }
    if (!this.config.qweatherApiHost) {
      const fallback = this.fallbackFromLastData(ctx.lastData);
      if (fallback) return fallback;
      throw new Error('QWEATHER_API_HOST 未配置，请在和风天气控制台-设置中复制你的 API Host');
    }

    const host = this.config.qweatherApiHost.replace(/\/+$/, '');
    const locationId = await this.resolveLocationId(host, apiKey, config.location_id);
    const location = encodeURIComponent(locationId);
    const unit = config.units === 'imperial' ? 'i' : 'm';
    const lang = 'zh';
    const nowUrl = `${host}/v7/weather/now?location=${location}&lang=${lang}&unit=${unit}`;
    const forecastUrl = `${host}/v7/weather/3d?location=${location}&lang=${lang}&unit=${unit}`;

    const [nowJson, forecastJson] = await Promise.all([
      fetchJson<QWeatherNowResponse>(nowUrl, apiKey),
      fetchJson<QWeatherForecastResponse>(forecastUrl, apiKey),
    ]);

    if (nowJson.code !== '200') throw new Error(`QWeather now code ${nowJson.code ?? 'unknown'}`);
    if (forecastJson.code !== '200')
      throw new Error(`QWeather forecast code ${forecastJson.code ?? 'unknown'}`);

    const nowData = nowJson.now ?? {};
    const windSpeed = toDisplayNumber(nowData.windSpeed);
    const windUnit = config.units === 'imperial' ? 'mph' : 'km/h';
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
          : `${windSpeed}${windUnit}`,
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
    locationId: string
  ): Promise<string> {
    if (/^\d+$/.test(locationId)) return locationId;
    const cached = this.lookupCache.get(locationId);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < LOOKUP_CACHE_TTL_MS) return cached.id;
    if (cached) this.lookupCache.delete(locationId);

    const existing = this.lookupInflight.get(locationId);
    if (existing) return existing;

    const p = this.fetchLocationId(host, apiKey, locationId)
      .then((id) => {
        this.lookupCache.set(locationId, { id, fetchedAt: Date.now() });
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

  private fallbackFromLastData(lastData: unknown): WeatherProviderData | null {
    if (!lastData || typeof lastData !== 'object' || Array.isArray(lastData)) return null;
    const data = lastData as Partial<WeatherProviderData>;
    if (!data.summary && data.tempC === undefined) return null;
    return {
      tempC: data.tempC ?? '--',
      feelsLikeC: data.feelsLikeC ?? '--',
      humidity: data.humidity ?? '--',
      pressure: data.pressure ?? '--',
      windDisplay: data.windDisplay ?? '--',
      summary: data.summary ?? '--',
      code: typeof data.code === 'number' ? data.code : 999,
      obsTime: data.obsTime ?? new Date().toISOString(),
      updatedAt: data.updatedAt ?? new Date().toISOString(),
      fc: Array.isArray(data.fc) ? data.fc.slice(0, 3) : [],
    };
  }
}

async function fetchJson<T>(url: string, apiKey: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'X-QW-Api-Key': apiKey },
    });
    if (!resp.ok) throw new Error(`QWeather HTTP ${resp.status}`);
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function toDisplayNumber(value: unknown): number | string {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : value;
  }
  return '--';
}

function forecastLabel(value: unknown, timeZone: string, now: Date): string | null {
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
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
    }).format(date);
  } catch {
    return value.slice(5);
  }
}

function datePartsInTz(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const year = Number(parts.find((p) => p.type === 'year')?.value);
    const month = Number(parts.find((p) => p.type === 'month')?.value);
    const day = Number(parts.find((p) => p.type === 'day')?.value);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return { year, month, day };
  } catch {
    return null;
  }
}

function ordinalDay(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}
