#!/usr/bin/env bun
/**
 * 获取 Claude Code 限额数据，推送到 Slate 的 ai_quota_monitor 动态帧。
 *
 * 数据获取：发一次最小请求到 Anthropic API，从 anthropic-ratelimit-unified-* headers
 * 提取 5h 窗口和 7 天限额的 utilization（0.0-1.0）和 reset 时间戳。
 *
 * 认证（按优先级）：
 *   1. 环境变量 ANTHROPIC_API_KEY（API key 或 OAuth Bearer token）
 *   2. 自动读取 ~/.claude/.credentials.json 中的 accessToken
 *
 * 环境变量：
 *   SLATE_API_BASE          Slate 后端地址，如 http://localhost:3000
 *   CLAUDE_QUOTA_CONTENT_ID Slate 中 ai_quota_monitor 类型动态帧的 contentId
 *   ANTHROPIC_API_KEY       （可选）Anthropic API key 或 OAuth token
 *   ANTHROPIC_API_BASE      （可选）API 地址，默认 https://api.anthropic.com
 *   CLAUDE_PLAN_LABEL       （可选）套餐标签，默认 "Pro"
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SLATE_API_BASE = env('SLATE_API_BASE');
const CONTENT_ID = env('CLAUDE_QUOTA_CONTENT_ID');
const ANTHROPIC_API_BASE = process.env.ANTHROPIC_API_BASE ?? 'https://api.anthropic.com';
const PLAN_LABEL = process.env.CLAUDE_PLAN_LABEL ?? 'Pro';

function env(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing env: ${key}`);
    process.exit(1);
  }
  return v;
}

// ── 认证：自动读取 OAuth token ──────────────────────────────────────

function resolveAuthToken(): string {
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) return envKey;

  const credPath = join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(credPath)) {
    console.error('No ANTHROPIC_API_KEY set and ~/.claude/.credentials.json not found');
    process.exit(1);
  }

  try {
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    const token = creds?.accessToken;
    if (!token) {
      console.error('No accessToken in .credentials.json');
      process.exit(1);
    }
    return token;
  } catch (e) {
    console.error('Failed to read .credentials.json:', e);
    process.exit(1);
  }
}

// ── Anthropic API 探测 ─────────────────────────────────────────────

interface UnifiedRateLimit {
  utilization5h: number; // 0.0 - 1.0
  reset5h: number; // Unix timestamp (seconds)
  utilization7d: number; // 0.0 - 1.0
  reset7d: number; // Unix timestamp (seconds)
  status: string; // allowed | allowed_warning | rejected
  bindingWindow: string; // five_hour | seven_day | ...
}

async function probeUnifiedRateLimit(token: string): Promise<UnifiedRateLimit | null> {
  try {
    const res = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
        'User-Agent': 'claude-code/2.1.5',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'quota' }],
      }),
    });

    const h = res.headers;

    // unified headers（Pro/Max 计划返回这些）
    const u5h = h.get('anthropic-ratelimit-unified-5h-utilization');
    const r5h = h.get('anthropic-ratelimit-unified-5h-reset');
    const u7d = h.get('anthropic-ratelimit-unified-7d-utilization');
    const r7d = h.get('anthropic-ratelimit-unified-7d-reset');
    const status = h.get('anthropic-ratelimit-unified-status') ?? '';
    const binding = h.get('anthropic-ratelimit-unified-representative-claim') ?? '';

    if (u5h != null && r5h != null) {
      return {
        utilization5h: parseFloat(u5h),
        reset5h: parseInt(r5h, 10),
        utilization7d: u7d != null ? parseFloat(u7d) : 0,
        reset7d: r7d != null ? parseInt(r7d, 10) : 0,
        status,
        bindingWindow: binding,
      };
    }

    // Fallback: legacy headers（API key 用户可能返回这些）
    const rl = h.get('anthropic-ratelimit-requests-limit');
    const rr = h.get('anthropic-ratelimit-requests-remaining');
    const rs = h.get('anthropic-ratelimit-requests-reset');

    if (rl && rr) {
      const limit = parseInt(rl, 10);
      const remaining = parseInt(rr, 10);
      const utilization = limit > 0 ? (limit - remaining) / limit : 0;
      const resetAt = rs ? Math.floor(new Date(rs).getTime() / 1000) : 0;
      return {
        utilization5h: utilization,
        reset5h: resetAt,
        utilization7d: 0,
        reset7d: 0,
        status: '',
        bindingWindow: 'five_hour',
      };
    }

    return null;
  } catch (e) {
    console.error('API probe failed:', e);
    return null;
  }
}

// ── 格式化 ─────────────────────────────────────────────────────────

function formatUnixTimestamp(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function nowLabel(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

// ── 主流程 ─────────────────────────────────────────────────────────

interface QuotaData {
  service_label: string;
  plan_label: string;
  status_label: string;
  primary_window_label: string;
  primary_used_percent: number;
  primary_reset_at_label: string;
  secondary_window_label: string;
  secondary_used_percent: number;
  secondary_reset_at_label: string;
  updated_label: string;
}

async function buildQuotaData(): Promise<QuotaData> {
  const token = resolveAuthToken();
  const rl = await probeUnifiedRateLimit(token);

  let primaryPercent = 0;
  let primaryResetLabel = '';
  let secondaryPercent = 0;
  let secondaryResetLabel = '';
  let statusLabel = '正常';

  if (rl) {
    primaryPercent = Math.round(rl.utilization5h * 100);
    primaryResetLabel = formatUnixTimestamp(rl.reset5h);
    secondaryPercent = Math.round(rl.utilization7d * 100);
    secondaryResetLabel = formatUnixTimestamp(rl.reset7d);

    if (rl.status === 'rejected') {
      statusLabel = '已限流';
    } else if (rl.status === 'allowed_warning') {
      statusLabel = '警告';
    } else if (primaryPercent >= 80 || secondaryPercent >= 80) {
      statusLabel = '警告';
    }
  } else {
    statusLabel = '未知';
  }

  return {
    service_label: 'Claude Code',
    plan_label: PLAN_LABEL,
    status_label: statusLabel,
    primary_window_label: '5h窗口',
    primary_used_percent: primaryPercent,
    primary_reset_at_label: primaryResetLabel,
    secondary_window_label: '周限额',
    secondary_used_percent: secondaryPercent,
    secondary_reset_at_label: secondaryResetLabel,
    updated_label: nowLabel(),
  };
}

async function push(data: QuotaData) {
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
  console.log('Pushed Claude Code quota to Slate:', JSON.stringify(result, null, 2));
}

async function main() {
  const quota = await buildQuotaData();
  console.log('Quota data:', JSON.stringify(quota, null, 2));
  await push(quota);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
