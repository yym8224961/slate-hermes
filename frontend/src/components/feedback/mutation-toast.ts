import { getApiErrorMessage } from '@/lib/api-errors';

export interface ToastText {
  message: string;
  hint?: string;
}

export type ToastInput<T> = string | ToastText | ((value: T) => string | ToastText);

type ToastPush = (message: string, hint?: string) => void;

export function showMutationErrorToast<T>(
  push: ToastPush,
  input: ToastInput<T> | undefined,
  value: T,
  error: unknown
) {
  if (!input) return;
  const text = resolveToastInput(input, value);
  if (typeof text === 'string') {
    push(text, getApiErrorMessage(error));
    return;
  }
  push(text.message, text.hint ?? getApiErrorMessage(error));
}

export function showMutationSuccessToast<T>(
  push: ToastPush,
  input: ToastInput<T> | undefined,
  value: T
) {
  if (!input) return;
  const text = resolveToastInput(input, value);
  if (typeof text === 'string') {
    push(text);
    return;
  }
  push(text.message, text.hint);
}

function resolveToastInput<T>(input: ToastInput<T>, value: T): string | ToastText {
  return typeof input === 'function' ? input(value) : input;
}
