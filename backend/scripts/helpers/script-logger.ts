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
  return truncateScriptLogText(await res.text().catch(() => ''), maxChars);
}

export function formatScriptError(err: unknown, maxChars = 512): string {
  return truncateScriptLogText(err instanceof Error ? err.message : String(err), maxChars);
}

export function truncateScriptLogText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}
