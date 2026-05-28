import { useCallback } from 'react';
import { useConfirm, type ConfirmOptions } from './Confirm';
import { useToast } from './Toast';

interface MutationCallbacks {
  onSuccess?: () => void;
  onError?: () => void;
}

interface ToastText {
  message: string;
  hint?: string;
}

type ToastInput<T> = string | ToastText | ((value: T) => string | ToastText);

interface ConfirmActionOptions<T> {
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

  return useCallback(
    async (value: T) => {
      if (isPending) return;
      const ok = await confirm(getConfirmOptions(value));
      if (!ok) return;
      run(value, {
        onSuccess: () => {
          showToast(toast.success, successToast, value);
          onSuccess?.(value);
        },
        onError: () => showToast(toast.error, errorToast, value),
      });
    },
    [confirm, errorToast, getConfirmOptions, isPending, onSuccess, run, successToast, toast]
  );
}

function showToast<T>(
  push: (message: string, hint?: string) => void,
  input: ToastInput<T> | undefined,
  value: T
) {
  if (!input) return;
  const text = typeof input === 'function' ? input(value) : input;
  if (typeof text === 'string') {
    push(text);
    return;
  }
  push(text.message, text.hint);
}
