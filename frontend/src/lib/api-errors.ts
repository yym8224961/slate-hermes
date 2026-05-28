import { AxiosError } from 'axios';

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
