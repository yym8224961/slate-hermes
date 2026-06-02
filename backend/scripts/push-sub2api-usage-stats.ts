#!/usr/bin/env bun
/**
 * 从 Sub2API 获取 AI 使用统计数据，推送到 Slate 的 ai_usage_stats 动态帧。
 *
 * 环境变量：
 *   SUB2API_BASE       Sub2API 地址，如 http://localhost:8080（不含 /api/v1）
 *   SUB2API_TOKEN      Bearer token（admin 或 user 级别）
 *   SLATE_API_BASE     Slate 后端地址，如 http://localhost:3000
 *   SUB2API_CONTENT_ID Slate 中 ai_usage_stats 类型动态帧的 contentId
 */

import { IngestPayload, type DashboardDataPayloadT } from 'shared';
import {
  createScriptLogger,
  formatScriptError,
  readScriptErrorBody,
  truncateScriptLogText,
} from './helpers/script-logger';

const logger = createScriptLogger('Sub2APIUsageStats');

const SUB2API_BASE = stripTrailingSlash(env('SUB2API_BASE'));
const SUB2API_TOKEN = env('SUB2API_TOKEN');
const SLATE_API_BASE = stripTrailingSlash(env('SLATE_API_BASE'));
const CONTENT_ID = env('SUB2API_CONTENT_ID');

function env(key: string): string {
  const v = process.env[key];
  if (!v) {
    logger.error(`Missing env ${key}.`);
    process.exit(1);
  }
  return v;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

async function sub2apiFetch<T>(path: string): Promise<T> {
  const url = `${SUB2API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SUB2API_TOKEN}` },
  });
  if (!res.ok) {
    const body = await readScriptErrorBody(res);
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

function formatLastUpdatedLabel(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatLastUpdatedTimeLabel(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}

function cacheHitRatePercent(
  inputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number
): number {
  const denominator = inputTokens + cacheCreationTokens + cacheReadTokens;
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return (cacheReadTokens / denominator) * 100;
}

function costPerMillionTokens(costUsd: number, tokenCount: number): number {
  if (!Number.isFinite(costUsd) || !Number.isFinite(tokenCount) || tokenCount <= 0) return 0;
  return (costUsd / tokenCount) * 1_000_000;
}

function buildDashboardData(stats: UserDashboardStats): DashboardDataPayloadT {
  return {
    today_cost_usd: stats.today_actual_cost,
    today_request_count: stats.today_requests,
    today_token_count: stats.today_tokens,
    today_cache_hit_rate_percent: cacheHitRatePercent(
      stats.today_input_tokens,
      stats.today_cache_creation_tokens,
      stats.today_cache_read_tokens
    ),
    total_cost_usd: stats.total_actual_cost,
    total_request_count: stats.total_requests,
    total_token_count: stats.total_tokens,
    total_cache_hit_rate_percent: cacheHitRatePercent(
      stats.total_input_tokens,
      stats.total_cache_creation_tokens,
      stats.total_cache_read_tokens
    ),
    average_latency_ms: stats.average_duration_ms,
    today_cost_per_million_tokens_usd: costPerMillionTokens(
      stats.today_actual_cost,
      stats.today_tokens
    ),
    total_cost_per_million_tokens_usd: costPerMillionTokens(
      stats.total_actual_cost,
      stats.total_tokens
    ),
    last_updated_time_label: formatLastUpdatedTimeLabel(),
    last_updated_label: formatLastUpdatedLabel(),
    platform_breakdown: (stats.by_platform ?? [])
      .toSorted(
        (a, b) =>
          b.today_actual_cost - a.today_actual_cost ||
          b.today_tokens - a.today_tokens ||
          b.today_requests - a.today_requests
      )
      .slice(0, 2)
      .map((p) => ({
        platform_name: p.platform,
        today_cost_usd: p.today_actual_cost,
        today_request_count: p.today_requests,
        today_token_count: p.today_tokens,
      })),
  };
}

async function pushDashboardData(data: DashboardDataPayloadT) {
  const url = `${SLATE_API_BASE}/api/v1/contents/${CONTENT_ID}/data`;
  const payload = IngestPayload.parse({ version: 1, data });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await readScriptErrorBody(res);
    throw new Error(`Slate push failed ${res.status}: ${body}`);
  }

  const result = await res.json();
  logger.info(
    `Slate accepted Sub2API usage stats push: ${truncateScriptLogText(JSON.stringify(result), 1000)}`
  );
}

async function main() {
  const stats = await sub2apiFetch<UserDashboardStats>('/api/v1/usage/dashboard/stats');
  await pushDashboardData(buildDashboardData(stats));
}

main().catch((e) => {
  logger.error(`Sub2API usage stats push failed: ${formatScriptError(e)}`);
  process.exit(1);
});
