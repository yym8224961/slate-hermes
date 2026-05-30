import { shortRegionName } from '../../weather-region';
import { pickText } from './frame-value-utils';

export function forecastTextFromVal(value: unknown): string {
  const text = pickText(value, '');
  if (!text) return '';
  return text.replace(/\s+\S*~\S*°$/, '').trim();
}

export function forecastRangeFromVal(value: unknown): string {
  const text = pickText(value, '');
  const m = text.match(/(-?\d+)°?(?:[~～]|-(?=\d))(-?\d+)°?$/);
  return m ? formatTemperatureRange(m[1], m[2]) : '';
}

export function formatTemperatureRange(min: string, max: string): string {
  const left = temperatureBound(min);
  const right = temperatureBound(max);
  if (left && right) return `${left}°~${right}°`;
  if (left) return `${left}°`;
  if (right) return `${right}°`;
  return '';
}

function temperatureBound(value: string): string | null {
  const text = value.trim().replace(/°+$/, '');
  return text && text !== '--' ? text : null;
}

export function weatherAlertLevel(title: string): { label: string; filled: boolean } {
  if (title.includes('红色')) return { label: '红', filled: true };
  if (title.includes('橙色')) return { label: '橙', filled: true };
  if (title.includes('黄色')) return { label: '黄', filled: false };
  if (title.includes('蓝色')) return { label: '蓝', filled: false };
  return { label: '警', filled: false };
}

export function weatherAlertSummary(title: string): {
  headline: string;
  source: string;
  sourceLabel: string;
  kindLabel: string;
  levelShort: string;
  level: { label: string; filled: boolean };
} {
  const normalized = title.replace(/\s+/g, '');
  const level = weatherAlertLevel(normalized);
  const publishMatch = normalized.match(/^(.*?)发布(.+?)预警(?:信号)?$/);
  const source = publishMatch?.[1] ?? '';
  const rawSignal = publishMatch?.[2] ?? normalized.replace(/预警(?:信号)?$/, '');
  const levelName = weatherAlertLevelName(rawSignal) || weatherAlertLevelName(normalized);
  const signal = rawSignal.replace(/(红色|橙色|黄色|蓝色)$/, '') || rawSignal || '气象';
  return {
    headline: `${levelName}${signal}预警`,
    source,
    sourceLabel: weatherAlertSourceLabel(source),
    kindLabel: weatherAlertKindLabel(signal),
    levelShort: weatherAlertLevelShort(levelName),
    level,
  };
}

function weatherAlertLevelName(title: string): string {
  const match = title.match(/(红色|橙色|黄色|蓝色)/);
  return match?.[1] ?? '';
}

function weatherAlertKindLabel(signal: string): string {
  const compact = signal.replace(/灾害|气象|预警|信号/g, '');
  if (compact.includes('雷雨大风')) return '雷暴';
  if (compact.includes('雷电')) return '雷电';
  if (compact.includes('暴雨')) return '暴雨';
  if (compact.includes('大风')) return '大风';
  if (compact.includes('台风')) return '台风';
  if (compact.includes('高温')) return '高温';
  if (compact.includes('大雾') || compact.includes('雾')) return '大雾';
  if (compact.includes('山洪')) return '山洪';
  if (compact.includes('暴雪')) return '暴雪';
  if (compact.includes('寒潮')) return '寒潮';
  if (compact.includes('冰雹')) return '冰雹';
  if (compact.length <= 2) return compact || '预警';
  return compact.slice(0, 2);
}

function weatherAlertLevelShort(levelName: string): string {
  if (levelName === '红色') return '红';
  if (levelName === '橙色') return '橙';
  if (levelName === '黄色') return '黄';
  if (levelName === '蓝色') return '蓝';
  return '警';
}

export function weatherAlertSourceLabel(source: string): string {
  return shortRegionName(source, { stripWeatherOffice: true });
}

export function weatherAlertLine(summary: {
  headline: string;
  source: string;
  sourceLabel: string;
  kindLabel: string;
  levelShort: string;
  level: { label: string; filled: boolean };
}): string {
  if (summary.levelShort && summary.sourceLabel) {
    return `${summary.levelShort} · ${summary.sourceLabel}`;
  }
  return summary.sourceLabel || summary.levelShort || summary.headline;
}

export function normalizeWeatherCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
