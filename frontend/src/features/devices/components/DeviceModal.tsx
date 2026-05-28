// 设备详情 modal — 取代了原 /devices/:did 单独路由页。
//
// 内容:
//   ① 标题区:在线状态点 + MAC + 设备名(铅笔图标 inline 改名)
//   ② 在播:当前在播组 + 切换 selector
//   ③ metadata 网格:电量 / 信号 / 固件 / 心跳
//   ④ 危险区:解绑(把 owner 置 null,素材保留)
//
// /devices/:did URL 仍可用 — 由 Dashboard 监听 useParams 自动打开 modal。

import { useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Pencil, Check, Wifi, Unlink, Radio } from 'lucide-react';
import type { DeviceSummaryT, GroupSummaryT } from 'shared';
import { usePatchDevice } from '@/features/devices/queries';
import { useGroups } from '@/features/groups/queries';
import { useToast } from '@/components/feedback/Toast';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Select, SelectItem, SelectSeparator } from '@/components/ui/Select';
import { isOnline, rssiLabel, useTimeAgo } from '@/lib/format';
import { BatteryLevelIcon } from './BatteryLevelIcon';
import { useUnbindDeviceWithConfirm } from './useUnbindDeviceWithConfirm';
import { inputCls, dialogContentWideCls, dialogOverlayCls } from '@/lib/styles';
import { cn } from '@/lib/cn';
import { useInlineRename } from '@/lib/hooks';

interface DeviceModalProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  device: DeviceSummaryT;
}

export function DeviceModal({ open, onOpenChange, device }: DeviceModalProps) {
  const groups = useGroups();
  const patch = usePatchDevice(device.id);
  const toast = useToast();
  const onUnbindSuccess = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { unbindWithConfirm, isPending: unbindPending } = useUnbindDeviceWithConfirm(
    device,
    onUnbindSuccess
  );

  const {
    editing: editingName,
    draft: draftName,
    setDraft: setDraftName,
    startEditing,
    commit,
    handleKeyDown,
  } = useInlineRename(device.name ?? '', async (name) => {
    await new Promise<void>((resolve, reject) => {
      patch.mutate(
        { name },
        {
          onSuccess: () => {
            toast.success('已改名');
            resolve();
          },
          onError: () => {
            toast.error('改名失败');
            reject();
          },
        }
      );
    });
  });

  const online = isOnline(device);
  const battery = device.battery_pct;
  const lastSeenAgo = useTimeAgo(device.last_seen_at);

  function changeGroup(value: string) {
    const next = value === '__none__' ? null : value;
    if (next === device.selected_group_id) return;
    patch.mutate(
      { selected_group_id: next },
      {
        onSuccess: () => toast.success(next ? '已切换在播' : '已清空在播'),
        onError: () => toast.error('切换失败'),
      }
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayCls} />
        <Dialog.Content className={dialogContentWideCls}>
          {/* 顶栏：状态点 + mac + 关闭 */}
          <div className="flex items-center justify-between gap-4 px-6 sm:px-7 pt-5 pb-3.5 border-b border-line">
            <div className="min-w-0">
              <p className="inline-flex items-center gap-2 text-[12px] text-stone">
                <span className={cn('dot', online ? 'dot-online' : 'dot-offline')} />
                {online ? '在线' : '离线'}
                <span className="font-mono text-[11px] text-stone-light">{device.mac}</span>
              </p>
              {/* 名称 + inline 改名 */}
              <div className="mt-1.5 flex items-center gap-2 min-w-0">
                {editingName ? (
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={commit}
                    onKeyDown={handleKeyDown}
                    maxLength={64}
                    placeholder="未命名"
                    className={cn(
                      inputCls,
                      'flex-1 min-w-0 !text-[24px] sm:!text-[26px] !font-serif !font-bold leading-tight'
                    )}
                  />
                ) : (
                  <Dialog.Title className="font-serif text-[24px] sm:text-[26px] font-bold leading-tight truncate">
                    {device.name ?? '未命名'}
                  </Dialog.Title>
                )}
                <button
                  onClick={() => {
                    if (editingName) commit();
                    else startEditing();
                  }}
                  disabled={patch.isPending}
                  aria-label={editingName ? '保存名称' : '改名'}
                  className="text-stone hover:text-ink disabled:opacity-50 transition-colors p-1.5 -m-1 hover:bg-cream"
                >
                  {editingName ? <Check size={16} /> : <Pencil size={14} />}
                </button>
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                aria-label="关闭"
                className="p-2 -m-2 text-stone hover:text-ink hover:bg-cream flex-shrink-0 transition-colors"
              >
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>

          {/* 主体 */}
          <div className="flex-1 overflow-y-auto px-6 sm:px-7 py-5 space-y-6">
            {/* 在播组切换 */}
            <section>
              <div className="flex items-center gap-2 mb-2 text-stone">
                <Radio size={14} />
                <h3 className="font-sans text-[12px] uppercase tracking-wide">在播</h3>
              </div>
              <GroupSelector
                groups={groups.data ?? []}
                value={device.selected_group_id}
                onChange={changeGroup}
                disabled={patch.isPending}
              />
              <p className="font-serif text-[12px] italic text-stone-light mt-2">
                切换后会立即向设备入队同步动作。
              </p>
            </section>

            {/* metadata 网格 — 离线时电量/信号灰显（数据已过期） */}
            <section>
              <h3 className="font-sans text-[12px] uppercase tracking-wide text-stone mb-2">
                状态
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <MetaCard
                  icon={<BatteryLevelIcon level={battery} size={16} />}
                  label="电量"
                  value={online && battery != null ? `${battery}%` : '—'}
                  warn={online && battery != null && battery < 20}
                  stale={!online}
                />
                <MetaCard
                  icon={<Wifi size={16} />}
                  label="信号"
                  value={online && device.rssi_dbm != null ? `${device.rssi_dbm} dBm` : '—'}
                  hint={online ? rssiLabel(device.rssi_dbm) : undefined}
                  stale={!online}
                />
                <MetaCard label="固件" value={device.fw_version ?? '—'} mono />
                <MetaCard label="心跳" value={lastSeenAgo} />
              </div>
            </section>

            {/* 危险区 */}
            <section className="pt-2">
              <Button
                variant="danger"
                size="sm"
                iconLeft={<Unlink size={14} />}
                onClick={unbindWithConfirm}
                disabled={unbindPending}
              >
                {unbindPending ? <Spinner /> : '从账号解绑'}
              </Button>
              <p className="font-serif text-[11px] italic text-stone-light mt-2">
                解绑后设备脱离你的账号，素材保留；重新添加可恢复。
              </p>
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MetaCard({
  icon,
  label,
  value,
  mono,
  warn,
  hint,
  stale,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  warn?: boolean;
  hint?: string;
  /** 数据已过期（设备离线），整卡灰显 */
  stale?: boolean;
}) {
  return (
    <div
      className={cn(
        'craft-card px-3.5 py-3 transition-opacity',
        warn && '!border-clay',
        stale && 'opacity-50'
      )}
    >
      <div className="flex items-center gap-1.5 text-stone">
        {icon}
        <span className="text-[11px]">{label}</span>
      </div>
      <p
        className={cn(
          'mt-1 text-ink',
          warn && 'text-clay',
          mono ? 'font-mono text-[12px] tabular-nums truncate' : 'font-serif text-[16px]'
        )}
      >
        {value}
      </p>
      {hint && <p className="font-sans text-[10px] text-stone-light mt-0.5">{hint}</p>}
    </div>
  );
}

function GroupSelector({
  groups,
  value,
  onChange,
  disabled,
}: {
  groups: GroupSummaryT[];
  value: string | null;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  // 只有「当前确实未选」时才提供「未选组」item，避免用户主动把已在播的设备退回空状态。
  const showNone = value === null;
  return (
    <Select
      value={value ?? '__none__'}
      onValueChange={onChange}
      disabled={disabled}
      placeholder="未选组"
      aria-label="切换在播组"
    >
      {showNone && <SelectItem value="__none__">未选组</SelectItem>}
      {showNone && groups.length > 0 && <SelectSeparator />}
      {groups.map((g) => (
        <SelectItem key={g.id} value={g.id} hint={`${g.content_count} 项`}>
          <span className="font-serif">{g.name}</span>
        </SelectItem>
      ))}
    </Select>
  );
}
