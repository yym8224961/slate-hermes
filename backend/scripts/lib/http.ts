import { readScriptErrorBody } from '../helpers/script-logger';

interface APIResponse<T> {
  code?: number;
  data?: T;
  message?: string;
}

type JSONHeaders = Record<string, string>;

function unwrapAPIResponse<T>(value: unknown, label: string): T {
  if (value && typeof value === 'object' && 'code' in value) {
    const json = value as APIResponse<T>;
    if (json.code === 0 || json.code === 200) {
      return json.data as T;
    }
    throw new Error(`${label} error ${json.code}: ${json.message ?? ''}`);
  }

  return value as T;
}

export async function fetchJSON<T>(url: string, init: RequestInit, label: string): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await readScriptErrorBody(res);
    throw new Error(`${label} ${res.status}: ${body}`);
  }

  const json = (await res.json()) as unknown;
  return unwrapAPIResponse<T>(json, label);
}

export async function getJSON<T>(url: string, label: string, headers?: JSONHeaders): Promise<T> {
  return fetchJSON<T>(url, { headers }, label);
}

export async function postJSON<T>(
  url: string,
  body: unknown,
  label: string,
  headers?: JSONHeaders
): Promise<T> {
  return fetchJSON<T>(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    },
    label
  );
}
