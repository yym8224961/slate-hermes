#!/usr/bin/env bun
/**
 * 从 Sub2API 获取 AI 使用统计数据，推送到 Slate 的 ai_usage_stats 动态帧。
 *
 * 环境变量：
 *   SUB2API_BASE       Sub2API 地址，如 http://localhost:8080
 *   SUB2API_TOKEN      Bearer token（admin 或 user 级别）
 *   SLATE_API_BASE     Slate 后端地址，如 http://localhost:3000
 *   SUB2API_CONTENT_ID Slate 中 ai_usage_stats 类型动态帧的 contentId
 *   SUB2API_USER_ID    （可选）指定用户 ID，默认查询当前 token 对应用户
 */

const SUB2API_BASE = env('SUB2API_BASE');
const SUB2API_TOKEN = env('SUB2API_TOKEN');
const SLATE_API_BASE = env('SLATE_API_BASE');
const CONTENT_ID = env('SUB2API_CONTENT_ID');

function env(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing env: ${key}`);
    process.exit(1);
  }
  return v;
}

async function sub2apiFetch<T>(path: string): Promise<T> {
  const url = `${SUB2API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SUB2API_TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sub2API ${path} ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { code: number; data: T; message?: string };
  if (json.code !== 0 && json.code !== 200) {
    throw new Error(`Sub2API ${path} error ${json.code}: ${json.message}`);
  }
  return json.data;
}

// Sub2API GET /api/v1/usage/dashboard/stats 响应
interface UserDashboardStats {
  total_api_keys: number;
  active_api_keys: number;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_tokens: number;
  total_cost: number;
  total_actual_cost: number;
  today_requests: number;
  today_input_tokens: number;
  today_output_tokens: number;
  today_cache_creation_tokens: number;
  today_cache_read_tokens: number;
  today_tokens: number;
  today_cost: number;
  today_actual_cost: number;
  average_duration_ms: number;
  rpm: number;
  tpm: number;
  by_platform?: Array<{
    platform: string;
    total_requests: number;
    total_tokens: number;
    total_actual_cost: number;
    today_requests: number;
    today_tokens: number;
    today_actual_cost: number;
  }>;
}

// Sub2API GET /api/v1/usage/dashboard/models 响应
interface ModelStat {
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost: number;
  actual_cost: number;
  account_cost: number;
}

interface ModelsResponse {
  models: ModelStat[];
}

function formatUpdatedLabel(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

async function main() {
  // 并行请求 stats + models
  const [stats, modelsRes] = await Promise.all([
    sub2apiFetch<UserDashboardStats>('/api/v1/usage/dashboard/stats'),
    sub2apiFetch<ModelsResponse>('/api/v1/usage/dashboard/models'),
  ]);

  const data: Record<string, unknown> = {
    balance: 0, // Sub2API 用户端无余额字段，admin 可按需补充
    total_api_keys: stats.total_api_keys,
    active_api_keys: stats.active_api_keys,
    total_tokens: stats.total_tokens,
    today_requests: stats.today_requests,
    today_actual_cost: stats.today_actual_cost,
    today_tokens: stats.today_tokens,
    average_duration_ms: stats.average_duration_ms,
    rpm: stats.rpm,
    updated_label: formatUpdatedLabel(),
    by_platform: (stats.by_platform ?? []).map((p) => ({
      platform: p.platform,
      today_actual_cost: p.today_actual_cost,
      total_tokens: p.total_tokens,
    })),
    models: (modelsRes.models ?? []).map((m) => ({
      model: m.model,
      total_tokens: m.total_tokens,
    })),
  };

  const url = `${SLATE_API_BASE}/api/v1/contents/${CONTENT_ID}/data`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, data }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slate push failed ${res.status}: ${body}`);
  }

  const result = await res.json();
  console.log('Pushed Sub2API usage stats to Slate:', JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
