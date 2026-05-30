import { useCallback } from 'react';
import { usePendingRef } from '@/hooks/usePendingRef';
import { useConfirm, type ConfirmOptions } from './Confirm';
import { useToast } from './Toast';
import {
  showMutationErrorToast,
  showMutationSuccessToast,
  type ToastInput,
} from './mutation-toast';

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
