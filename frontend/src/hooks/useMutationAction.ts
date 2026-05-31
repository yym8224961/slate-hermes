import { useCallback, useLayoutEffect, useRef } from 'react';
import { useConfirm, type ConfirmOptions } from '@/components/feedback/confirm-context';
import { useToast } from '@/components/feedback/toast-context';
import { getApiErrorMessage } from '@/lib/api-errors';

export interface ToastText {
  message: string;
  hint?: string;
}

export type ToastInput<T> = string | ToastText | ((value: T) => string | ToastText);

export interface MutationCallbacks {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

export interface MutationActionOptions<T> {
  isPending: boolean;
  run: (value: T, callbacks: MutationCallbacks) => void;
  successToast?: ToastInput<T>;
  errorToast?: ToastInput<T>;
  onSuccess?: (value: T) => void;
}

export interface ConfirmActionOptions<T> extends MutationActionOptions<T> {
  getConfirmOptions: (value: T) => ConfirmOptions;
}

export function useMutationAction<T>({
  isPending,
  run,
  successToast,
  errorToast,
  onSuccess,
}: MutationActionOptions<T>) {
  const toast = useToast();
  const isPendingRef = usePendingRef(isPending);

  return useCallback(
    (value: T) => {
      if (isPendingRef.current) return;
      run(value, {
        onSuccess: () => {
          showMutationSuccessToast(toast.success, successToast, value);
          onSuccess?.(value);
        },
        onError: (error) => showMutationErrorToast(toast.error, errorToast, value, error),
      });
    },
    [errorToast, isPendingRef, onSuccess, run, successToast, toast]
  );
}

type ToastPush = (message: string, hint?: string) => void;

function showMutationErrorToast<T>(
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

function showMutationSuccessToast<T>(push: ToastPush, input: ToastInput<T> | undefined, value: T) {
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

function usePendingRef(isPending: boolean) {
  const isPendingRef = useRef(isPending);
  useLayoutEffect(() => {
    isPendingRef.current = isPending;
  }, [isPending]);
  return isPendingRef;
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
  const isPendingRef = usePendingRef(isPending);

  return useCallback(
    async (value: T) => {
      if (isPendingRef.current) return;
      const ok = await confirm(getConfirmOptions(value));
      if (!ok) return;
      run(value, {
        onSuccess: () => {
          showMutationSuccessToast(toast.success, successToast, value);
          onSuccess?.(value);
        },
        onError: (error) => showMutationErrorToast(toast.error, errorToast, value, error),
      });
    },
    [confirm, errorToast, getConfirmOptions, isPendingRef, onSuccess, run, successToast, toast]
  );
}
