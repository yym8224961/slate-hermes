// 全局 toast — Radix Toast 风格化。两种语调：
//   info（默认）：奶米底 + 砖红边
//   error：     砖红底 + 白字
//
// 用法：
//   const toast = useToast();
//   toast.success('已添加'); toast.error('MAC 已被他人占用');
//
// 在 app 根挂 <ToastProvider /> 一次。

import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import * as RT from '@radix-ui/react-toast';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ToastCtx, type ToastApi } from './toast-context';

type Tone = 'success' | 'error' | 'info';

interface ToastItem {
  id: string;
  tone: Tone;
  message: string;
  hint?: string;
}

const MAX_TOASTS = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((tone: Tone, message: string, hint?: string) => {
    setItems((p) => [...p, { id: createToastId(), tone, message, hint }].slice(-MAX_TOASTS));
  }, []);
  const closeToast = useCallback((id: string) => {
    setItems((p) => p.filter((item) => item.id !== id));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, h) => push('success', m, h),
      error: (m, h) => push('error', m, h),
      info: (m, h) => push('info', m, h),
    }),
    [push]
  );

  return (
    <ToastCtx.Provider value={api}>
      <RT.Provider swipeDirection="right" duration={4000}>
        {children}
        {items.map((it) => (
          <ToastBody key={it.id} item={it} onClose={closeToast} />
        ))}
        <RT.Viewport className="fixed bottom-5 right-5 sm:bottom-7 sm:right-7 z-[100] flex flex-col gap-2.5 w-[min(380px,calc(100vw-2rem))] outline-none" />
      </RT.Provider>
    </ToastCtx.Provider>
  );
}

const ToastBody = memo(function ToastBody({
  item,
  onClose,
}: {
  item: ToastItem;
  onClose: (id: string) => void;
}) {
  const Icon = item.tone === 'success' ? CheckCircle2 : item.tone === 'error' ? AlertCircle : Info;

  const tone =
    item.tone === 'error' ? 'bg-ink text-paper border-ink' : 'bg-paper border-ink text-ink';

  const iconClass =
    item.tone === 'error' ? 'text-paper' : item.tone === 'success' ? 'text-ink' : 'text-stone';

  return (
    <RT.Root
      onOpenChange={(o) => {
        if (!o) onClose(item.id);
      }}
      className={cn(
        'group flex items-start gap-3 px-4 py-3 border-2 shadow-md',
        'data-[state=open]:animate-in data-[state=open]:slide-in-from-right-4',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out',
        tone
      )}
    >
      <Icon size={18} className={cn('mt-0.5 flex-shrink-0', iconClass)} />
      <div className="min-w-0 flex-1">
        <RT.Title className="font-serif text-[14px] font-medium leading-snug">
          {item.message}
        </RT.Title>
        {item.hint && (
          <RT.Description className="font-sans text-[12px] opacity-80 mt-1 leading-relaxed">
            {item.hint}
          </RT.Description>
        )}
      </div>
    </RT.Root>
  );
});

function createToastId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
