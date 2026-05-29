#!/usr/bin/env bun
/**
 * 获取 Claude Code 限额数据，推送到 Slate 的 ai_quota_monitor 动态帧。
 *
 * 数据获取：
 *   1. Claude Code statusLine 模式：从 stdin 读取 rate_limits，输出状态栏并后台推送。
 *   2. 独立运行模式：发一次最小请求到 Anthropic API，从 headers 提取限额。
 *
 * 独立运行模式认证（按优先级）：
 *   1. 环境变量 ANTHROPIC_API_KEY（API key 或 OAuth Bearer token）
 *   2. 自动读取 ~/.claude/.credentials.json 中的 accessToken
 *
 * 环境变量：
 *   SLATE_API_BASE          Slate 后端地址，如 http://localhost:3000
 *   CLAUDE_QUOTA_CONTENT_ID Slate 中 ai_quota_monitor 类型动态帧的 contentId
 *   ANTHROPIC_API_KEY       （可选）Anthropic API key 或 OAuth token
 *   ANTHROPIC_API_BASE      （可选）API 地址，默认 https://api.anthropic.com
 *   CLAUDE_PLAN_LABEL       （可选）套餐标签，默认 "Max 20x"
 *   CLAUDE_QUOTA_PUSH_INTERVAL_MS （可选）statusLine 模式推送限频，默认 60000
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { IngestPayload, type DashboardDataPayloadT } from 'shared';

const SLATE_API_BASE = stripTrailingSlash(env('SLATE_API_BASE'));
const CONTENT_ID = env('CLAUDE_QUOTA_CONTENT_ID');
const ANTHROPIC_API_BASE = stripTrailingSlash(
  process.env.ANTHROPIC_API_BASE ?? 'https://api.anthropic.com'
);
const PLAN_LABEL = process.env.CLAUDE_PLAN_LABEL ?? 'Max 20x';
const PUSH_INTERVAL_MS = readPositiveInt(process.env.CLAUDE_QUOTA_PUSH_INTERVAL_MS, 60_000);
const CACHE_DIR = join(homedir(), '.cache', 'slate-claude-quota');
const LOG_PATH = join(CACHE_DIR, 'push.log');
const LAST_PUSH_TS = join(CACHE_DIR, 'last-push-ts');
const PAYLOAD_PATH = join(CACHE_DIR, 'pending-payload.json');

mkdirSync(CACHE_DIR, { recursive: true });

if (process.argv[2] === '--push') {
  await pushPendingPayload();
  process.exit(0);
}

function env(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing env: ${key}`);
    process.exit(1);
  }
  return v;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function log(msg: string) {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // Logging must never break the statusLine command.
  }
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

// ── Claude Code statusLine stdin ───────────────────────────────────

interface ClaudeCodeStatusLineInput {
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
}

interface QuotaLimitSnapshot {
  pct5h: number;
  reset5h: number;
  pct7d: number;
  reset7d: number;
}

async function readStatusLineInput(): Promise<ClaudeCodeStatusLineInput | null> {
  if (process.stdin.isTTY) return null;
  try {
    const raw = (await readStdinWithTimeout(500)).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClaudeCodeStatusLineInput;
    return parsed.rate_limits ? parsed : null;
  } catch {
    return null;
  }
}

async function readStdinWithTimeout(ms: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      process.stdin.destroy();
      resolve(Buffer.concat(chunks).toString('utf-8'));
    }, ms);
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
  });
}

function rateLimitsFromStatusLine(input: ClaudeCodeStatusLineInput): QuotaLimitSnapshot | null {
  const rl = input.rate_limits;
  if (!rl) return null;
  return {
    pct5h: clampPercent(rl.five_hour?.used_percentage ?? 0),
    reset5h: readUnixSeconds(rl.five_hour?.resets_at),
    pct7d: clampPercent(rl.seven_day?.used_percentage ?? 0),
    reset7d: readUnixSeconds(rl.seven_day?.resets_at),
  };
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

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function readUnixSeconds(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function formatReset5h(sec: number): string {
  if (!sec) return '--';
  const d = new Date(sec * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return `${sameDay ? '' : '明 '}${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatReset7d(sec: number): string {
  if (!sec) return '--';
  const d = new Date(sec * 1000);
  return `${WEEKDAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function nowLabel(): string {
  const d = new Date();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${mm}-${dd} ${hh}:${mi}`;
}

function bar(pct: number): string {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '▓'.repeat(n) + '░'.repeat(10 - n);
}

function formatStatusLine(limits: QuotaLimitSnapshot): string {
  return `5h ${bar(limits.pct5h)} ${Math.round(limits.pct5h)}% ${formatReset5h(limits.reset5h)} | 7d ${bar(limits.pct7d)} ${Math.round(limits.pct7d)}% ${formatReset7d(limits.reset7d)}`;
}

function statusLabelForLimits(
  primaryPercent: number,
  secondaryPercent: number,
  apiStatus?: string
): string {
  if (apiStatus === 'rejected' || primaryPercent >= 100 || secondaryPercent >= 100) {
    return '已限流';
  }
  if (apiStatus === 'allowed_warning' || primaryPercent >= 80 || secondaryPercent >= 80) {
    return '警告';
  }
  return '正常';
}

// ── 主流程 ─────────────────────────────────────────────────────────

interface QuotaData extends Record<string, unknown> {
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

function buildQuotaDataFromLimits(limits: QuotaLimitSnapshot, apiStatus?: string): QuotaData {
  const primaryPercent = Math.round(clampPercent(limits.pct5h));
  const secondaryPercent = Math.round(clampPercent(limits.pct7d));
  return {
    service_label: 'Claude Code',
    plan_label: PLAN_LABEL,
    status_label: statusLabelForLimits(primaryPercent, secondaryPercent, apiStatus),
    primary_window_label: '5h窗口',
    primary_used_percent: primaryPercent,
    primary_reset_at_label: formatReset5h(limits.reset5h),
    secondary_window_label: '周限额',
    secondary_used_percent: secondaryPercent,
    secondary_reset_at_label: formatReset7d(limits.reset7d),
    updated_label: nowLabel(),
  };
}

async function buildQuotaDataFromProbe(): Promise<QuotaData> {
  const token = resolveAuthToken();
  const rl = await probeUnifiedRateLimit(token);

  if (!rl) {
    return {
      ...buildQuotaDataFromLimits({ pct5h: 0, reset5h: 0, pct7d: 0, reset7d: 0 }),
      status_label: '未知',
    };
  }

  return buildQuotaDataFromLimits(
    {
      pct5h: rl.utilization5h * 100,
      reset5h: rl.reset5h,
      pct7d: rl.utilization7d * 100,
      reset7d: rl.reset7d,
    },
    rl.status
  );
}

function buildPayload(data: DashboardDataPayloadT): string {
  return JSON.stringify(IngestPayload.parse({ version: 1, data }));
}

function shouldPush(): boolean {
  try {
    return Date.now() - Number(readFileSync(LAST_PUSH_TS, 'utf-8').trim()) >= PUSH_INTERVAL_MS;
  } catch {
    return true;
  }
}

async function pushPayloadBody(body: string) {
  const url = `${SLATE_API_BASE}/api/v1/contents/${CONTENT_ID}/data`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slate push failed ${res.status}: ${body}`);
  }

  const result = await res.json();
  console.log('Pushed Claude Code quota to Slate:', JSON.stringify(result, null, 2));
}

async function push(data: DashboardDataPayloadT) {
  await pushPayloadBody(buildPayload(data));
}

async function pushPendingPayload() {
  try {
    await pushPayloadBody(readFileSync(PAYLOAD_PATH, 'utf-8'));
    log('ok');
  } catch (e) {
    log(`error ${e}`);
  }
}

function spawnBackgroundPush() {
  const child = spawn(process.execPath, [import.meta.filename, '--push'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function scheduleStatusLinePush(data: DashboardDataPayloadT, limits: QuotaLimitSnapshot) {
  if (!shouldPush()) return;
  writeFileSync(LAST_PUSH_TS, String(Date.now()));
  writeFileSync(PAYLOAD_PATH, buildPayload(data));
  spawnBackgroundPush();
  log(`push 5h=${Math.round(limits.pct5h)}% 7d=${Math.round(limits.pct7d)}%`);
}

async function main() {
  const statusLineInput = await readStatusLineInput();
  const statusLineLimits = statusLineInput ? rateLimitsFromStatusLine(statusLineInput) : null;
  if (statusLineLimits) {
    process.stdout.write(formatStatusLine(statusLineLimits));
    scheduleStatusLinePush(buildQuotaDataFromLimits(statusLineLimits), statusLineLimits);
    return;
  }

  const quota = await buildQuotaDataFromProbe();
  console.log('Quota data:', JSON.stringify(quota, null, 2));
  await push(quota);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
