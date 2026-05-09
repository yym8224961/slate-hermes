// 按 MAC 添加设备(多用户场景下唯一入口)。
//
// MAC 输入支持空格/横杠/冒号/纯 hex 等任何形式,提交时规范化为
// AA:BB:CC:DD:EE:FF 大写。
//
// 三种结果(均由 server 决定):
//   ① 设备未注册   → 创建占位记录, owner=me, 设备首次联网自动归属
//   ② 设备无主     → 直接绑定
//   ③ 设备属他人   → 服务端 403,toast 提示

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, X, Cpu } from 'lucide-react';
import { useClaimByMac } from '../lib/queries';
import { useToast } from './Toast';
import { isValidMac, normalizeMac } from '../lib/format';
import { Input } from './Input';
import { Button } from './Button';
import { Spinner } from './Spinner';
import { IconBlock } from './IconBlock';

interface AddDeviceDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function AddDeviceDialog({ open, onOpenChange }: AddDeviceDialogProps) {
  const [mac, setMac] = useState('');
  const [name, setName] = useState('');
  const claim = useClaimByMac();
  const toast = useToast();

  const macValid = isValidMac(mac);

  function reset() {
    setMac('');
    setName('');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!macValid) return;
    try {
      await claim.mutateAsync({
        mac: normalizeMac(mac),
        name: name.trim() || undefined,
      });
      toast.success('设备已添加', '设备首次联网会自动归属于你');
      reset();
      onOpenChange(false);
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { error?: string } } };
      if (e.response?.status === 403) {
        toast.error('该 MAC 已被其他用户绑定');
      } else {
        toast.error('添加失败', e.response?.data?.error);
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
                <Cpu size={18} />
              </IconBlock>
              <div className="min-w-0">
                <Dialog.Title className="font-kai text-[24px] leading-tight">添加设备</Dialog.Title>
                <Dialog.Description className="font-kai text-[13px] text-stone mt-1 leading-relaxed">
                  输入设备 MAC 即绑定到当前账号。设备未联网也可先添加。
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
              label="MAC 地址"
              value={mac}
              onChange={(e) => setMac(e.target.value)}
              placeholder="AA:BB:CC:DD:EE:FF"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              hint={mac && !macValid ? undefined : '冒号/横杠/空格皆可,会自动规范'}
              error={mac && !macValid ? 'MAC 格式不正确' : undefined}
              className="font-mono"
            />
            <Input
              label="备注名(选填)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如:客厅"
              maxLength={64}
            />

            <div className="flex items-center justify-end gap-3 pt-2">
              <Dialog.Close asChild>
                <Button variant="outline" type="button">
                  取消
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                disabled={!macValid || claim.isPending}
                iconRight={claim.isPending ? undefined : <ArrowRight size={14} />}
              >
                {claim.isPending ? <Spinner /> : '添加'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
