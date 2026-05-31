import { DashboardTemplate, type DashboardTemplateT, type DynamicConfigT } from 'shared';
import { canonicalJsonKey } from '@/features/dynamic/lib/json';

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

export function dynamicConfigKey(config: DynamicConfigT): string {
  return canonicalJsonKey(config);
}
