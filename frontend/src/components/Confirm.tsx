/* eslint-disable react-refresh/only-export-components */
// 全局 confirm:替代浏览器 window.confirm,用 Radix Dialog 风格化。
//
// 用法:
//   const confirm = useConfirm();
//   if (await confirm({ title: '删除这一帧?', description: '此操作不可逆。', destructive: true })) {
//     del.mutate(...);
//   }
//
// 在 App 根挂 <ConfirmProvider /> 一次。

import { createContext, useCallback, useContext, useState, useRef, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle } from 'lucide-react';
import { Button } from './Button';
import { IconBlock } from './IconBlock';
import { dialogContentConfirmCls, dialogOverlayConfirmCls } from '../lib/styles';

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}

type Resolve = (ok: boolean) => void;

const ConfirmCtx = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<Resolve | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setOpts(options);
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    resolveRef.current?.(ok);
    resolveRef.current = null;
    setOpts(null);
  }, []);

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog.Root
        open={!!opts}
        onOpenChange={(open) => {
          if (!open) close(false);
        }}
      >
        <Dialog.Portal>
          {/* z-index 故意比其它 dialog 高一档:
                普通 dialog (FrameEditor / Groups create): overlay z-40 / content z-50
                Confirm                                  : overlay z-50 / content z-60
              因为业务里 dialog 内部还可能再触发 confirm(如 FrameEditor 删音频),
              confirm 必须盖在那些 dialog 之上。改前请确认这条不变量。 */}
          <Dialog.Overlay className={dialogOverlayConfirmCls} />
          <Dialog.Content className={dialogContentConfirmCls}>
            <div className="flex items-center gap-4">
              <IconBlock size="lg" tone={opts?.destructive ? 'danger' : 'muted'}>
                <AlertTriangle size={24} />
              </IconBlock>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="font-serif text-[20px] font-bold leading-[1.2]">
                  {opts?.title}
                </Dialog.Title>
                {opts?.description && (
                  <Dialog.Description className="font-sans text-[13px] text-stone mt-1.5 leading-relaxed">
                    {opts.description}
                  </Dialog.Description>
                )}
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3">
              <Button variant="outline" onClick={() => close(false)}>
                {opts?.cancelText ?? '取消'}
              </Button>
              <Button
                variant={opts?.destructive ? 'danger' : 'primary'}
                onClick={() => close(true)}
                autoFocus
              >
                {opts?.confirmText ?? '确认'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error('useConfirm outside ConfirmProvider');
  return ctx;
}
