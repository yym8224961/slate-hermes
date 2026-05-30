import { useContext } from 'react';
import { ToastCtx, type ToastApi } from './toast-context';

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}
