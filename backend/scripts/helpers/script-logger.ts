export interface ScriptLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createScriptLogger(scope: string): ScriptLogger {
  return {
    info: (message) => writeLog('INFO', scope, message, process.stdout),
    warn: (message) => writeLog('WARN', scope, message, process.stderr),
    error: (message) => writeLog('ERROR', scope, message, process.stderr),
  };
}

function writeLog(
  level: string,
  scope: string,
  message: string,
  stream: NodeJS.WritableStream
): void {
  stream.write(`[${new Date().toISOString()}] ${level} [${scope}] ${message}\n`);
}

export async function readScriptErrorBody(res: Response, maxChars = 1000): Promise<string> {
  return truncateScriptLogText(redactScriptLogText(await res.text().catch(() => '')), maxChars);
}

export function formatScriptError(err: unknown, maxChars = 512): string {
  return truncateScriptLogText(
    redactScriptLogText(err instanceof Error ? err.message : String(err)),
    maxChars
  );
}

export function redactScriptLogText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"'\\]+/gi, 'Bearer [REDACTED]')
    .replace(/\brlh_[A-Za-z0-9_-]+\b/g, 'rlh_[REDACTED]')
    .replace(/\/api\/v1\/contents\/[^/\s"'?]+\/data/g, '/api/v1/contents/[REDACTED]/data')
    .replace(
      /(["']?(?:authorization|token|contentId)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]'
    );
}

export function truncateScriptLogText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}
