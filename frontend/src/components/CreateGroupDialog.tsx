import { useEffect, useState } from 'react';
import { FolderHeart, Layers, Webhook, ArrowRight, Check } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { Input } from './Input';
import { Button } from './Button';
import { Spinner } from './Spinner';
import { DialogHeader } from './DialogHeader';
import { cn } from '../lib/cn';
import { dialogContentCls, dialogOverlayCls } from '../lib/styles';

export function CreateGroupDialog({
  open,
  onOpenChange,
  onCreate,
  isPending,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (name: string, kind: 'static' | 'dynamic') => Promise<void> | void;
  isPending: boolean;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'static' | 'dynamic'>('static');

  useEffect(() => {
    if (!open) {
      setName('');
      setKind('static');
    }
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayCls} />
        <Dialog.Content className={dialogContentCls}>
          <DialogHeader
            icon={<FolderHeart size={24} />}
            title="新建组"
            description="相册手动上传，看板由 webhook 推数据。"
            className="mb-6"
          />

          <div className="space-y-5">
            <Input
              label="名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="如：每日卡片"
            />

            <div>
              <p className="block font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-2">
                类型
              </p>
              <div className="grid grid-cols-2 gap-0 border border-ink">
                {(['static', 'dynamic'] as const).map((k) => {
                  const active = kind === k;
                  const Icon = k === 'static' ? Layers : Webhook;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setKind(k)}
                      aria-pressed={active}
                      className={cn(
                        'relative text-left px-4 py-3.5 border-r border-ink last:border-r-0 transition-colors',
                        active
                          ? 'bg-ink text-paper'
                          : 'bg-paper text-stone hover:bg-cream-deep hover:text-ink'
                      )}
                    >
                      {active && (
                        <span className="absolute top-2.5 right-2.5">
                          <Check size={11} strokeWidth={3} />
                        </span>
                      )}
                      <Icon size={18} />
                      <p className="font-serif text-[15px] font-medium mt-2">
                        {k === 'static' ? '静态相册' : '动态看板'}
                      </p>
                      <p className="font-sans text-[11px] mt-1 leading-tight opacity-70">
                        {k === 'static' ? '手动上传图片/音频' : 'Webhook 渲染外部数据'}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-7 flex items-center justify-end gap-3">
            <Dialog.Close asChild>
              <Button variant="outline">取消</Button>
            </Dialog.Close>
            <Button
              onClick={() => name.trim() && onCreate(name.trim(), kind)}
              disabled={!name.trim() || isPending}
              iconRight={isPending ? undefined : <ArrowRight size={14} />}
            >
              {isPending ? <Spinner /> : '创建'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
