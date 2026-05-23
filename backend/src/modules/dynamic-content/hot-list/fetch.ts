export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

type RequestHeaders = Record<string, string> | Array<[string, string]> | Headers;
type FetchOptions = {
  signal: AbortSignal;
  headers?: RequestHeaders;
  method?: string;
  body?: unknown;
};

export async function fetchJson<T>(url: string, opts: FetchOptions): Promise<T> {
  const text = await fetchText(url, opts);
  return JSON.parse(text) as T;
}

export async function fetchText(url: string, opts: FetchOptions): Promise<string> {
  const headers = new Headers(opts.headers);
  if (!headers.has('User-Agent')) headers.set('User-Agent', DESKTOP_UA);
  const body =
    opts.body === undefined
      ? undefined
      : typeof opts.body === 'string' || opts.body instanceof Buffer
        ? opts.body
        : JSON.stringify(opts.body);
  const resp = await fetch(url, {
    signal: opts.signal,
    method: opts.method,
    headers,
    body,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
  return await resp.text();
}
