import { createScriptLogger } from '../helpers/script-logger';

const logger = createScriptLogger('ScriptEnv');

export function readEnv(name: string): string {
  return String(process.env[name] ?? '').trim();
}

export function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`Missing env ${name}`);
  }
  return value;
}

export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.trunc(parsed);
  }

  logger.warn(`Ignoring invalid positive integer env ${name}=${raw}`);
  return fallback;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
