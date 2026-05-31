import { createContext, useContext } from 'react';

export interface ToastApi {
  success: (msg: string, hint?: string) => void;
  error: (msg: string, hint?: string) => void;
  info: (msg: string, hint?: string) => void;
}

export const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}
