import { useContext } from 'react';
import { ConfirmCtx, type ConfirmFn, type ConfirmOptions } from './confirm-context';

export type { ConfirmOptions };

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error('useConfirm outside ConfirmProvider');
  return ctx;
}
