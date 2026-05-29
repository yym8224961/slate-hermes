import { useCallback, useLayoutEffect, useRef } from 'react';
import { getApiErrorMessage } from '@/lib/api-errors';
import { useConfirm, type ConfirmOptions } from './Confirm';
import { useToast } from './Toast';

interface MutationCallbacks {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

interface ToastText {
  message: string;
  hint?: string;
}

type ToastInput<T> = string | ToastText | ((value: T) => string | ToastText);

export interface ConfirmActionOptions<T> {
  isPending: boolean;
  getConfirmOptions: (value: T) => ConfirmOptions;
  run: (value: T, callbacks: MutationCallbacks) => void;
  successToast?: ToastInput<T>;
  errorToast?: ToastInput<T>;
  onSuccess?: (value: T) => void;
}

export function useConfirmAction<T>({
  isPending,
  getConfirmOptions,
  run,
  successToast,
  errorToast,
  onSuccess,
}: ConfirmActionOptions<T>) {
  const confirm = useConfirm();
  const toast = useToast();
  const isPendingRef = useRef(isPending);
  useLayoutEffect(() => {
    isPendingRef.current = isPending;
  }, [isPending]);

  return useCallback(
    async (value: T) => {
      if (isPendingRef.current) return;
      const ok = await confirm(getConfirmOptions(value));
      if (!ok) return;
      run(value, {
        onSuccess: () => {
          showToast(toast.success, successToast, value);
          onSuccess?.(value);
        },
        onError: (error) => showErrorToast(toast.error, errorToast, value, error),
      });
    },
    [confirm, errorToast, getConfirmOptions, onSuccess, run, successToast, toast]
  );
}

function showErrorToast<T>(
  push: (message: string, hint?: string) => void,
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

function showToast<T>(
  push: (message: string, hint?: string) => void,
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
