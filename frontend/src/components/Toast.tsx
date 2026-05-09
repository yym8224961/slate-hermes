/* eslint-disable react-refresh/only-export-components */
// 全局 toast — Radix Toast 风格化。两种语调:
//   info(默认):奶米底 + 砖红边
//   error:     砖红底 + 白字
//
// 用法:
//   const toast = useToast();
//   toast.success('已添加'); toast.error('MAC 已被他人占用');
//
// 在 app 根挂 <ToastProvider /> 一次。

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import * as RT from '@radix-ui/react-toast';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { cn } from '../lib/cn';

type Tone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
  hint?: string;
}

interface ToastApi {
  success: (msg: string, hint?: string) => void;
  error: (msg: string, hint?: string) => void;
  info: (msg: string, hint?: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((tone: Tone, message: string, hint?: string) => {
    setItems((p) => [...p, { id: Date.now() + Math.random(), tone, message, hint }]);
  }, []);

  const api: ToastApi = {
    success: (m, h) => push('success', m, h),
    error: (m, h) => push('error', m, h),
    info: (m, h) => push('info', m, h),
  };

  return (
    <ToastCtx.Provider value={api}>
      <RT.Provider swipeDirection="right" duration={4000}>
        {children}
        {items.map((it) => (
          <ToastBody
            key={it.id}
            item={it}
            onClose={() => setItems((p) => p.filter((x) => x.id !== it.id))}
          />
        ))}
        <RT.Viewport className="fixed bottom-5 right-5 sm:bottom-7 sm:right-7 z-[100] flex flex-col gap-2.5 w-[min(380px,calc(100vw-2rem))] outline-none" />
      </RT.Provider>
    </ToastCtx.Provider>
  );
}

function ToastBody({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const Icon = item.tone === 'success' ? CheckCircle2 : item.tone === 'error' ? AlertCircle : Info;

  const tone = item.tone === 'error' ? 'bg-clay text-paper border-clay' : 'bg-paper border-line';

  const iconClass =
    item.tone === 'error' ? 'text-paper' : item.tone === 'success' ? 'text-moss' : 'text-clay';

  return (
    <RT.Root
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      className={cn(
        'group flex items-start gap-3 px-4 py-3 rounded-[14px] border shadow-[0_12px_28px_rgba(61,40,23,0.16)]',
        'data-[state=open]:animate-in data-[state=open]:slide-in-from-right-4',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out',
        tone
      )}
    >
      <Icon size={18} className={cn('mt-0.5 flex-shrink-0', iconClass)} />
      <div className="min-w-0 flex-1">
        <RT.Title className="font-kai text-[15px] leading-snug">{item.message}</RT.Title>
        {item.hint && (
          <RT.Description className="font-sans text-[12px] opacity-80 mt-1 leading-relaxed">
            {item.hint}
          </RT.Description>
        )}
      </div>
    </RT.Root>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}
