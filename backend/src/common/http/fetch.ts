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
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const ERROR_BODY_SNIPPET_CHARS = 512;

export class HttpStatusError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly statusText: string,
    readonly bodySnippet: string
  ) {
    super(
      `HTTP ${status}${statusText ? ` ${statusText}` : ''} for ${url}` +
        (bodySnippet ? `: ${bodySnippet}` : '')
    );
    this.name = 'HttpStatusError';
  }
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, opts);
  return JSON.parse(text) as T;
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
    typeof body === 'string' ||
    (body !== undefined &&
      !(body instanceof Buffer) &&
      !(body instanceof ArrayBuffer) &&
      !(body instanceof Blob) &&
      !(body instanceof FormData) &&
      !(body instanceof URLSearchParams))
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

async function responseSnippet(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => '');
  return text.replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_SNIPPET_CHARS);
}
