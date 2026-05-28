import axios, { type AxiosError } from 'axios';
import { getAuthToken, notifyUnauthorized } from './auth-storage';

export const API_V1 = '/api/v1';

export const api = axios.create({
  baseURL: '/',
  timeout: 30_000,
});

api.interceptors.request.use((config) => {
  const token = getAuthToken();
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
