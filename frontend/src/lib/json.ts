import { DashboardTemplate, type DashboardTemplateT } from 'shared';

export function parseDashboardTemplate(
  text: string
): { ok: true; template: DashboardTemplateT } | { ok: false; error: string } {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const template = DashboardTemplate.safeParse(parsed.data);
  if (!template.success) {
    return { ok: false, error: template.error.issues[0]?.message ?? '模板格式非法' };
  }
  return { ok: true, template: template.data };
}

export function parseJsonRecord(
  text: string
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    return { ok: false, error: '必须是 JSON object' };
  }
  return { ok: true, data: parsed.data as Record<string, unknown> };
}

export function parseJson(
  text: string
): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'JSON 解析失败' };
  }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (value === null) return ['null'];
  if (value === undefined) return ['undefined'];
  if (typeof value === 'string') return ['string', value];
  if (typeof value === 'number') {
    return Number.isFinite(value) ? ['number', value] : ['number', String(value)];
  }
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value === 'function') return ['function', String(value)];
  if (typeof value === 'symbol') return ['symbol', value.description ?? null];
  if (Array.isArray(value)) {
    return ['array', value.map(sortJsonValue)];
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return ['date', Number.isNaN(time) ? 'Invalid Date' : value.toISOString()];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(value).sort()) {
    const next = (value as Record<string, unknown>)[key];
    entries.push([key, sortJsonValue(next)]);
  }
  return ['object', entries];
}
