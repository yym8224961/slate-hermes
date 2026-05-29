export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

export type RequestHeaders = Record<string, string> | Array<[string, string]> | Headers;

export interface FetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: RequestHeaders;
  method?: string;
  body?: unknown;
  userAgent?: string | null;
  allowPrivateNetwork?: boolean;
  requireJsonContentType?: boolean;
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const ERROR_BODY_SNIPPET_CHARS = 512;
const ERROR_BODY_READ_LIMIT_BYTES = 8 * 1024;
const JSON_CONTENT_TYPE_RE = /^(?:application\/json|[^;/]+\/[^;/]+\+json)(?:\s*;|$)/i;

export class HttpStatusError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly statusText: string,
    readonly bodySnippet: string
  ) {
    super(
      `HTTP ${status}${statusText ? ` ${statusText}` : ''} for ${redactUrlForMessage(url)}` +
        (bodySnippet ? `: ${bodySnippet}` : '')
    );
    this.name = 'HttpStatusError';
  }
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const resp = await fetchResponse(url, opts);
  const contentType = resp.headers.get('content-type') ?? '';
  if (opts.requireJsonContentType && contentType && !JSON_CONTENT_TYPE_RE.test(contentType)) {
    throw new Error(`Expected JSON response from ${redactUrlForMessage(url)}, got ${contentType}`);
  }
  const body = await resp.text();
  try {
    return JSON.parse(body) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid JSON response from ${redactUrlForMessage(url)}` +
        (contentType ? ` (content-type: ${contentType})` : '') +
        `: ${detail}`
    );
  }
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const resp = await fetchResponse(url, opts);
  return await resp.text();
}

export async function fetchArrayBuffer(url: string, opts: FetchOptions = {}): Promise<ArrayBuffer> {
  const resp = await fetchResponse(url, opts);
  return await resp.arrayBuffer();
}

export async function fetchResponse(url: string, opts: FetchOptions = {}): Promise<Response> {
  if (!opts.allowPrivateNetwork) assertPublicHttpUrl(url);
  const headers = new Headers(opts.headers);
  if (opts.userAgent !== null && !headers.has('User-Agent')) {
    headers.set('User-Agent', opts.userAgent ?? DESKTOP_UA);
  }
  if (opts.body !== undefined && shouldDefaultJsonContentType(opts.body, headers)) {
    headers.set('Content-Type', 'application/json');
  }

  const resp = await fetchWithTimeout(url, {
    method: opts.method,
    headers,
    body: requestBody(opts.body),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
  if (!resp.ok) {
    throw new HttpStatusError(url, resp.status, resp.statusText, await responseSnippet(resp));
  }
  return resp;
}

export function isPublicHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !isPrivateHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function assertPublicHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported URL protocol: ${parsed.protocol}`);
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error(`private network URL is not allowed: ${parsed.hostname}`);
  }
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (isPrivateIpv6Hostname(host)) return true;

  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map((part) => Number(part));
  if (octets.some((part) => part < 0 || part > 255 || !Number.isInteger(part))) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 240
  );
}

function isPrivateIpv6Hostname(host: string): boolean {
  const mapped = host.match(/^::ffff:([0-9a-f:.]+)$/i);
  if (mapped?.[1]) {
    return isPrivateHostname(mapped[1]) || isPrivateMappedIpv6Tail(mapped[1]);
  }

  if (host === 'fc00::' || host === 'fd00::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  return false;
}

function isPrivateMappedIpv6Tail(tail: string): boolean {
  const match = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!match) return false;
  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return false;
  return isPrivateHostname(
    `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
  );
}

export async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  if (timeoutMs <= 0) {
    return fetch(input, init);
  }

  const upstreamSignal = init.signal;
  if (upstreamSignal?.aborted) {
    throw abortReason(upstreamSignal);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort(upstreamSignal ? abortReason(upstreamSignal) : undefined);
  upstreamSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', onAbort);
  }
}

function requestBody(body: unknown): RequestInit['body'] {
  if (body === undefined) return undefined;
  if (
    typeof body === 'string' ||
    body instanceof Buffer ||
    body instanceof ArrayBuffer ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams
  ) {
    return body;
  }
  return JSON.stringify(body);
}

function shouldDefaultJsonContentType(body: unknown, headers: Headers): boolean {
  if (headers.has('Content-Type')) return false;
  return (
    body !== undefined &&
    typeof body !== 'string' &&
    !(body instanceof Buffer) &&
    !(body instanceof ArrayBuffer) &&
    !(body instanceof Blob) &&
    !(body instanceof FormData) &&
    !(body instanceof URLSearchParams)
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

async function responseSnippet(resp: Response): Promise<string> {
  const text = await readResponseSnippetText(resp).catch(() => '');
  return text.replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_SNIPPET_CHARS);
}

async function readResponseSnippetText(resp: Response): Promise<string> {
  if (!resp.body) return '';
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < ERROR_BODY_READ_LIMIT_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = ERROR_BODY_READ_LIMIT_BYTES - bytes;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function redactUrlForMessage(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}
