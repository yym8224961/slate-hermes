// 共享 axios 实例：自动附加 Bearer JWT，401 时通知 AuthProvider 清登录态并跳 /login。

import axios, { AxiosError } from 'axios';

const TOKEN_KEY = 'slate_jwt';
export const API_V1 = '/api/v1';
let unauthorizedHandler: (() => void) | null = null;

export const api = axios.create({
  baseURL: '/',
  timeout: 30_000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    if (err.response?.status === 401) {
      // 不在拦截器里清 token：AuthProvider 的 handler 会做 tokenStorage.clear() + setToken(null) +
      // qc.clear() + navigate('/login')，单一职责。handler 未注册（App 启动前的早期 401）时退化为
      // 硬跳，保证用户不会停留在已失效的页面看到空数据。
      if (unauthorizedHandler) {
        unauthorizedHandler();
      } else {
        localStorage.removeItem(TOKEN_KEY);
        if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
      }
    }
    return Promise.reject(err);
  }
);

export function setUnauthorizedHandler(handler: () => void): () => void {
  if (unauthorizedHandler && unauthorizedHandler !== handler) {
    // 双挂载（StrictMode / HMR）会先卸载再装载，正常应当先看到清理回调把单例清空；
    // 若到这里 unauthorizedHandler 仍非空，说明上一份 handler 没正确 dispose，可能是
    // 漏写 useEffect 返回值，开发时尽早暴露出来。
    console.warn('[api] setUnauthorizedHandler overwriting an existing handler');
  }
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

export const tokenStorage = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (v: string) => localStorage.setItem(TOKEN_KEY, v),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

interface ApiErrorResponse {
  message?: string;
  error?: string;
}

export type ApiError = AxiosError<ApiErrorResponse>;

export function getApiErrorMessage(err: unknown, fallback = '操作失败'): string {
  if (err instanceof AxiosError) {
    const data = err.response?.data as ApiErrorResponse | undefined;
    return data?.message ?? data?.error ?? fallback;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export function getApiErrorStatus(err: unknown): number | undefined {
  if (err instanceof AxiosError) return err.response?.status;
  return undefined;
}

export function isApiErrorWithStatus(err: unknown, status: number): boolean {
  return getApiErrorStatus(err) === status;
}
