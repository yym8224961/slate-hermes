// 共享 axios 实例：自动附加 Bearer JWT，401 时清 token + 跳 /login。

import axios, { AxiosError } from 'axios';

const TOKEN_KEY = 'slate_jwt';

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
      // 不在 /login 才跳转，避免登录页自己 401 时无限循环
      const path = window.location.pathname;
      if (path !== '/login') {
        localStorage.removeItem(TOKEN_KEY);
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export const tokenStorage = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (v: string) => localStorage.setItem(TOKEN_KEY, v),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};
