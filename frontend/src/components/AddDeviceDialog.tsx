// 按设备屏上的 6 位配对码绑定设备。
//
// 流程：用户拿到一台已经联网但未绑定的 Slate 设备 → 设备屏上显示配对码 →
// 用户在此对话框输入 → 后端找到 device、把 owner 设为当前用户、轮换 pair_code。
//
// 命名留到绑定后在设备列表 PATCH name。

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, X, KeyRound } from 'lucide-react';
import { useClaimByPairCode } from '../lib/queries';
import { useToast } from './Toast';
import { isValidPairCode, normalizePairCode } from '../lib/format';
import { Input } from './Input';
import { Button } from './Button';
import { Spinner } from './Spinner';
import { IconBlock } from './IconBlock';

interface AddDeviceDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function AddDeviceDialog({ open, onOpenChange }: AddDeviceDialogProps) {
  const [code, setCode] = useState('');
  const claim = useClaimByPairCode();
  const toast = useToast();

  const codeValid = isValidPairCode(code);

  function reset() {
    setCode('');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!codeValid) return;
    try {
      await claim.mutateAsync({ code: normalizePairCode(code) });
      toast.success('设备已绑定', '设备屏会自动切到「等待相册」');
      reset();
      onOpenChange(false);
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { error?: string } } };
      if (e.response?.status === 404) {
        toast.error('配对码无效', '请核对设备屏上的码,或在设备上长按 ENTER 工厂重置后重试');
      } else if (e.response?.status === 403) {
        toast.error('该设备已被其他账号绑定', '在设备上工厂重置后再试');
      } else {
        toast.error('绑定失败', e.response?.data?.error);
      }
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30 backdrop-blur-[2px] z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-2rem)] max-w-md bg-paper border border-line rounded-[20px] z-50 p-7 shadow-[0_24px_64px_rgba(61,40,23,0.16)]">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div className="flex items-start gap-3 min-w-0">
              <IconBlock tone="soft">
                <KeyRound size={18} />
              </IconBlock>
              <div className="min-w-0">
                <Dialog.Title className="font-kai text-[24px] leading-tight">添加设备</Dialog.Title>
                <Dialog.Description className="font-kai text-[13px] text-stone mt-1 leading-relaxed">
                  在设备屏上查看 6 位配对码,输入此处即绑定。
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                aria-label="关闭"
                className="p-1.5 -m-1.5 text-stone hover:text-ink hover:bg-cream rounded-[10px]"
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>

          <form onSubmit={onSubmit} className="space-y-5">
            <Input
              label="配对码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="K7M9X2"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              maxLength={9}
              hint={code && !codeValid ? undefined : '6 位字母+数字,大小写均可'}
              error={code && !codeValid ? '配对码格式不正确' : undefined}
              className="font-mono uppercase tracking-[0.2em] text-center"
            />

            <div className="flex items-center justify-end gap-3 pt-2">
              <Dialog.Close asChild>
                <Button variant="outline" type="button">
                  取消
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                disabled={!codeValid || claim.isPending}
                iconRight={claim.isPending ? undefined : <ArrowRight size={14} />}
              >
                {claim.isPending ? <Spinner /> : '绑定'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
