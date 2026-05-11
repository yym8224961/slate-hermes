// API 错误处理工具函数。

import { AxiosError } from 'axios';

/** API 错误响应结构 */
interface ApiErrorResponse {
  message?: string;
  error?: string;
}

/** API 错误类型 */
export type ApiError = AxiosError<ApiErrorResponse>;

/**
 * 从 API 错误中提取错误消息。
 *
 * @param err - 捕获的错误
 * @param fallback - 默认错误消息
 * @returns 错误消息字符串
 */
export function getApiErrorMessage(err: unknown, fallback = '操作失败'): string {
  if (err instanceof AxiosError) {
    const data = err.response?.data;
    return data?.message ?? data?.error ?? fallback;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return fallback;
}

/**
 * 从 API 错误中提取 HTTP 状态码。
 *
 * @param err - 捕获的错误
 * @returns HTTP 状态码，如果不是 AxiosError 则返回 undefined
 */
export function getApiErrorStatus(err: unknown): number | undefined {
  if (err instanceof AxiosError) {
    return err.response?.status;
  }
  return undefined;
}

/**
 * 判断是否为特定 HTTP 状态码的错误。
 *
 * @param err - 捕获的错误
 * @param status - 要检查的 HTTP 状态码
 * @returns 是否为指定状态码的错误
 */
export function isApiErrorWithStatus(err: unknown, status: number): boolean {
  return getApiErrorStatus(err) === status;
}
