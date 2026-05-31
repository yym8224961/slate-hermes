import { type DynamicConfigT } from 'shared';
import { recordValue, valueText } from '../../../common/utils/value-utils';
import {
  normalizeHistoryYear,
  parseHistoryTodayData,
  type HistoryTodayProviderData,
} from '../history-today.data';
import { cnMonthDay, datePartsInTz, timezoneFromConfig } from '../timezone';
import { shortRegionName } from '../weather-region';

export function buildDynamicAudioTextForContent(
  dynamicType: string,
  config: DynamicConfigT,
  data: unknown,
  now: Date = new Date()
): string {
  switch (dynamicType) {
    case 'daily_calendar':
      return buildDailyCalendarAudio(data, config, now);
    case 'month_calendar':
      return buildMonthCalendarAudio(data, config, now);
    case 'weather':
      return buildWeatherAudio(data, config);
    case 'history_today':
      return buildHistoryTodayAudio(data, config, now);
    case 'weather_alert':
      return buildWeatherAlertAudio(data, config);
    case 'earthquake_report':
      return buildEarthquakeReportAudio(data);
    default:
      return '';
  }
}

function buildDailyCalendarAudio(data: unknown, config: DynamicConfigT, now: Date): string {
  const parts = datePartsInTz(now, timezoneFromConfig(config));
  const month = valueText(recordValue(data, 'month')) ?? String(parts.month);
  const day = valueText(recordValue(data, 'day')) ?? String(parts.day);
  const weekday = valueText(recordValue(data, 'weekdayCN')) ?? '';
  const lunar = valueText(recordValue(data, 'lunarDate')) ?? valueText(recordValue(data, 'lunar'));
  const term = valueText(recordValue(data, 'solarTerm'));
  const festival = valueText(recordValue(data, 'festival'));
  return compactSentence([
    `今天是${month}月${day}日${weekday ? `，${weekday}` : ''}`,
    lunar ? `${lunar}` : '',
    term ? `今日节气${term}` : '',
    festival ? `今天是${festival}` : '',
  ]);
}

function buildMonthCalendarAudio(data: unknown, config: DynamicConfigT, now: Date): string {
  const parts = datePartsInTz(now, timezoneFromConfig(config));
  const monthKey = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
  const dayKey = `${monthKey}-${String(parts.day).padStart(2, '0')}`;
  const days = recordValue(
    recordValue(recordValue(recordValue(data, 'calendar'), 'months'), monthKey),
    'days'
  );
  const today = recordValue(days, dayKey);
  const lunar = valueText(recordValue(today, 'lunar_date'));
  const term = valueText(recordValue(today, 'solar_term'));
  const festival = valueText(recordValue(today, 'festival'));
  return compactSentence([
    `现在是${parts.year}年${parts.month}月`,
    `今天${parts.month}月${parts.day}日`,
    lunar ? `${lunar}` : '',
    term ? `今日节气${term}` : '',
    festival ? `今天是${festival}` : '',
  ]);
}

function buildWeatherAudio(data: unknown, config: DynamicConfigT): string {
  const location = valueText(recordValue(config, 'location_label')) ?? '本地';
  const summary = valueText(recordValue(data, 'summary')) ?? '天气数据暂不可用';
  const temp = valueText(recordValue(data, 'tempC'));
  const feels = valueText(recordValue(data, 'feelsLikeC'));
  const humidity = valueText(recordValue(data, 'humidity'));
  const wind = valueText(recordValue(data, 'windDisplay'));
  return compactSentence([
    `${location}今天天气，${summary}`,
    temp ? `${temp}度` : '',
    feels ? `体感${feels}度` : '',
    humidity ? `湿度${humidity}%` : '',
    wind ? `${wind}` : '',
  ]);
}

function buildHistoryTodayAudio(data: unknown, config: DynamicConfigT, now: Date): string {
  const parsed = parseHistoryTodayData(data);
  if (!parsed) return '';
  const label = parsed.dateLabel || cnMonthDay(now, timezoneFromConfig(config));
  const items = historyAudioItems(parsed);
  return compactSentence([`历史上的${label.replace(/\s+/g, '')}`, ...items]);
}

function buildWeatherAlertAudio(data: unknown, config: DynamicConfigT): string {
  const items = recordArray(recordValue(data, 'items'));
  const province =
    valueText(recordValue(data, 'province')) || valueText(recordValue(config, 'province')) || '';
  const region = province ? shortRegionName(province) : '全国';
  if (items.length === 0) return `${region}暂无气象预警`;

  const warnings = items.slice(0, 3).flatMap((item): string[] => {
    const title = valueText(recordValue(item, 'title'));
    if (!title) return [];
    return [weatherAlertAudioLine(title)];
  });
  if (warnings.length === 0) return `${region}暂无气象预警`;
  return compactSentence([`${region}气象预警，播报最新${cnCount(warnings.length)}条`, ...warnings]);
}

function buildEarthquakeReportAudio(data: unknown): string {
  const items = recordArray(recordValue(data, 'items'));
  if (items.length === 0) return '暂无地震速报';

  const latest = earthquakeLatestAudio(items[0]);
  const rest = items.slice(1, 4).map(earthquakeBriefAudio).filter(Boolean);
  const restText = rest.length > 0 ? `其余${cnCount(rest.length)}条：${rest.join('；')}` : '';
  return compactSentence(['中国地震台网最新速报', latest, restText]);
}

function historyAudioItems(data: HistoryTodayProviderData): string[] {
  return data.items.map((item) => `${formatSpokenYear(item.year)}，${item.display}`);
}

function formatSpokenYear(year: string): string {
  const text = normalizeHistoryYear(year) ?? year.trim();
  if (text.startsWith('前')) return `公元前${text.slice(1)}年`;
  return `公元${text}年`;
}

function compactSentence(parts: string[]): string {
  return parts
    .map((part) => part.trim().replace(/[。；;,，]+$/g, ''))
    .filter(Boolean)
    .join('。')
    .slice(0, 500);
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => {
        return !!item && typeof item === 'object' && !Array.isArray(item);
      })
    : [];
}

function weatherAlertAudioLine(title: string): string {
  const normalized = title.replace(/\s+/g, '');
  const match = normalized.match(/^(.*?)发布(.+?)预警(?:信号)?$/);
  if (!match) return normalized.replace(/预警信号/g, '预警');

  const source = shortRegionName(match[1] ?? '');
  const signal = (match[2] ?? '').replace(/预警(?:信号)?$/g, '');
  return source ? `${source}发布${signal}预警` : `${signal}预警`;
}

function earthquakeLatestAudio(item: Record<string, unknown>): string {
  const location = valueText(recordValue(item, 'location')) ?? '';
  const magnitude = valueText(recordValue(item, 'magnitude')) ?? '';
  const depth = valueText(recordValue(item, 'depthKm')) ?? '';
  const occurredAt = valueText(recordValue(item, 'occurredAt')) ?? '';
  return compactSentence([
    `最新一条，${location || '未知位置'}`,
    magnitude ? `震级${magnitude}级` : '',
    depth && depth !== '-' && depth !== '--' ? `震源深度${depth}千米` : '',
    occurredAt ? `发生时间${shortSpokenTime(occurredAt)}` : '',
  ]);
}

function earthquakeBriefAudio(item: Record<string, unknown>): string {
  const location = valueText(recordValue(item, 'location')) ?? '';
  const magnitude = valueText(recordValue(item, 'magnitude')) ?? '';
  return [location || '未知位置', magnitude ? `震级${magnitude}级` : ''].filter(Boolean).join('，');
}

function cnCount(value: number): string {
  return ['零', '一', '二', '三', '四'][value] ?? String(value);
}

function shortSpokenTime(value: string): string {
  const text = value.trim();
  const match = text.match(/(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})日?\s+(\d{1,2}):(\d{2})/);
  if (!match) return text;
  return `${Number(match[2])}月${Number(match[3])}日${Number(match[4])}点${match[5]}分`;
}
