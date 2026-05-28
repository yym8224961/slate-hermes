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

export function canonicalJsonKey(value: unknown): string {
  return formatJsonKey(value);
}

function formatJsonKey(value: unknown): string {
  if (value === null) return 'n';
  if (value === undefined) return 'u';
  if (typeof value === 'string') return `s:${JSON.stringify(value)}`;
  if (typeof value === 'number') {
    return `d:${JSON.stringify(Number.isFinite(value) ? value : String(value))}`;
  }
  if (typeof value === 'boolean') return `b:${value ? '1' : '0'}`;
  if (typeof value === 'bigint') return `i:${value.toString()}`;
  if (typeof value === 'function') return `f:${JSON.stringify(String(value))}`;
  if (typeof value === 'symbol') return `y:${JSON.stringify(value.description ?? null)}`;
  if (Array.isArray(value)) {
    return `a:[${value.map(formatJsonKey).join(',')}]`;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return `t:${JSON.stringify(Number.isNaN(time) ? 'Invalid Date' : value.toISOString())}`;
  }
  return `o:{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${formatJsonKey((value as Record<string, unknown>)[key])}`
    )
    .join(',')}}`;
}
