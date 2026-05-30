import { createContext } from 'react';

export interface ToastApi {
  success: (msg: string, hint?: string) => void;
  error: (msg: string, hint?: string) => void;
  info: (msg: string, hint?: string) => void;
}

export const ToastCtx = createContext<ToastApi | null>(null);
