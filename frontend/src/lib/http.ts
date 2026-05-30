import axios, { type AxiosError } from 'axios';
import { API_PREFIX } from 'shared';
import { notifyUnauthorized } from '@/features/auth/lib/auth-events';
import { tokenStorage } from '@/features/auth/lib/auth-storage';

export { API_PREFIX };

export const api = axios.create({
  baseURL: '/',
  timeout: 30_000,
});

api.interceptors.request.use((config) => {
  const token = tokenStorage.get();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    if (err.response?.status === 401) {
      notifyUnauthorized();
    }
    return Promise.reject(err);
  }
);
