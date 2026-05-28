import { DASHBOARD_SYSTEM_TEMPLATES, DashboardConfig, type DashboardTemplateT } from 'shared';
import type { DynamicRenderContext } from './dynamic-frame-renderer.service';
import { FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import { clamp, isRecord, pickText, readInt, readNumberArray } from './frame-value-utils';

export const STATUS_BAR_H = 24;

export function blockRect(
  block: Record<string, unknown>
): { x: number; y: number; w: number; h: number } | null {
  const x = readInt(block.x, -1, 0, FRAME_WIDTH - 1);
  const y = readInt(block.y, -1, STATUS_BAR_H, FRAME_HEIGHT - 1);
  const w = readInt(block.w, -1, 1, FRAME_WIDTH);
  const h = readInt(block.h, -1, 1, FRAME_HEIGHT - STATUS_BAR_H);
  if (x < 0 || y < STATUS_BAR_H || w < 1 || h < 1) return null;
  return {
    x,
    y,
    w: Math.min(w, FRAME_WIDTH - x),
    h: Math.min(h, FRAME_HEIGHT - y),
  };
}

export function resolveDashboardRenderInput(
  ctx: DynamicRenderContext
): { template: DashboardTemplateT; data: Record<string, unknown> } | null {
  const config = DashboardConfig.safeParse(ctx.config);
  if (!config.success) return null;
  const data = ctx.data ?? config.data.test_data;
  if (!isRecord(data)) return null;
  if (config.data.template.kind === 'custom') {
    return { template: config.data.template.template, data };
  }
  const system = DASHBOARD_SYSTEM_TEMPLATES[config.data.template.id];
  return { template: system.template, data };
}

export function resolveTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(
    /\{([a-zA-Z0-9_.-]+)(?:\|([a-zA-Z0-9_]+))?\}/g,
    (_m, path: string, format?: string) => {
      const value = resolvePath(data, path);
      if (Array.isArray(value)) return value.join(' ');
      if (value === null || value === undefined) return '';
      return formatDashboardValue(value, format);
    }
  );
}

export function resolvePath(data: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = data;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (!isRecord(cur) && !Array.isArray(cur)) return undefined;
    if (Array.isArray(cur)) {
      if (part === '*') {
        const rest = parts.slice(i + 1).join('.');
        return rest ? cur.map((item) => resolvePathFromUnknown(item, rest)) : cur;
      }
      const idx = Number(part);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else {
      cur = cur[part];
    }
  }
  return cur;
}

function resolvePathFromUnknown(value: unknown, path: string): unknown {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  return resolvePath(value as Record<string, unknown>, path);
}

export function resolveSeries(value: unknown, data: Record<string, unknown>): number[] {
  if (Array.isArray(value)) return readNumberArray(value);
  if (typeof value !== 'string') return [];
  const match = value.match(/^\{([a-zA-Z0-9_.*-]+)\}$/);
  if (match) return readNumberArray(resolvePath(data, match[1]!));
  return readNumberArray(
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

export function resolvePercentage(
  value: unknown,
  rawUsed: unknown,
  rawMax: unknown,
  data: Record<string, unknown>
): number {
  const direct =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(resolveTemplate(value, data).replace(/%$/, ''))
        : NaN;
  if (Number.isFinite(direct)) return clamp(direct, 0, 100);

  const used = Number(resolveTemplate(pickText(rawUsed, ''), data));
  const max = Number(resolveTemplate(pickText(rawMax, ''), data));
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return 0;
  return clamp((used / max) * 100, 0, 100);
}

function formatDashboardValue(value: unknown, format: string | undefined): string {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!format || !Number.isFinite(n)) return String(value);
  switch (format) {
    case 'int':
      return Math.trunc(n).toLocaleString('en-US');
    case 'tokens':
      return formatCompact(n);
    case 'compact':
      return formatCompact(n);
    case 'usd':
      return `$${formatUsd(n, 2)}`;
    case 'usd2':
      return `$${formatUsd(n, 2)}`;
    case 'usd4':
      return `$${formatUsd(n, 4)}`;
    case 'duration':
      return n >= 1000 ? `${trimFixed(n / 1000, 2)}s` : `${Math.round(n)}ms`;
    default:
      return String(value);
  }
}

function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trimFixed(value / 1_000_000_000, 1)}B`;
  if (abs >= 1_000_000) return `${trimFixed(value / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `${trimFixed(value / 1_000, 1)}K`;
  return String(Math.trunc(value));
}

function formatUsd(value: number, digits: number): string {
  return value.toFixed(digits);
}

function trimFixed(value: number, digits: number): string {
  return value
    .toFixed(digits)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}
