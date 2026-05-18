// 设备卡片：可拖拽排序 + 在线状态点 + 电量/信号 + 底部操作行。

import {
  Wifi,
  Battery,
  BatteryWarning,
  BatteryCharging,
  Frame,
  Trash2,
  GripVertical,
} from 'lucide-react';
import { useMemo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useUnbindDevice } from '@/features/devices/queries';
import type { DeviceSummaryT, GroupSummaryT } from 'shared';
import { IconBlock } from '@/components/ui/IconBlock';
import { useToast } from '@/components/feedback/Toast';
import { useConfirm } from '@/components/feedback/Confirm';
import { isOnline, timeAgo, rssiLabel } from '@/lib/format';
import { cn } from '@/lib/cn';

export function DeviceCard({
  device,
  groups,
  onOpen,
}: {
  device: DeviceSummaryT;
  groups: GroupSummaryT[];
  onOpen: () => void;
}) {
  const online = isOnline(device);
  const currentGroup = groups.find((g) => g.id === device.selected_group_id);
  const groupName = currentGroup?.name;
  const battery = device.battery_pct;
  const lowBattery = battery != null && battery < 20;
  const BatteryIcon =
    battery == null
      ? Battery
      : battery < 20
        ? BatteryWarning
        : battery < 80
          ? Battery
          : BatteryCharging;

  const unbind = useUnbindDevice();
  const toast = useToast();
  const confirm = useConfirm();

  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: device.id,
    animateLayoutChanges: () => false,
  });
  const style = useMemo(
    () => ({
      transform: CSS.Transform.toString(transform),
      transition: 'none' as const,
      zIndex: isDragging ? 10 : undefined,
    }),
    [transform, isDragging]
  );

  const playingContents = currentGroup?.content_count;

  async function onUnbind(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const ok = await confirm({
      title: '解绑这台设备？',
      description: `${device.name ?? device.mac} 将从你的账号移除。素材保留，设备屏会切回配对码状态。`,
      destructive: true,
      confirmText: '解绑',
    });
    if (!ok) return;
    unbind.mutate(device.id, {
      onSuccess: () => toast.success('已解绑', '设备屏会显示新配对码。'),
      onError: () => toast.error('解绑失败'),
    });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'craft-card flex flex-col overflow-hidden',
        isDragging && 'shadow-drag opacity-90'
      )}
      data-hoverable="true"
    >
      <button
        onClick={onOpen}
        className="block w-full text-left px-5 pt-5 pb-4 sm:px-6 sm:pt-6 sm:pb-4 hover:bg-cream transition-colors"
      >
        <div className="flex items-start gap-3">
          <IconBlock size="lg" tone="soft">
            <Frame size={24} />
          </IconBlock>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-serif text-[18px] font-bold leading-tight truncate tracking-tight">
                {device.name ?? '未命名'}
              </h3>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-stone flex-shrink-0">
                <span className={cn('dot', online ? 'dot-online' : 'dot-offline')} />
                {online ? '在线' : '离线'}
              </span>
            </div>

            <p className="font-mono text-[11px] text-stone-light mt-1 truncate">
              {device.id.slice(0, 12)}
            </p>

            <p className="mt-2 truncate">
              <span className="font-sans text-[9px] uppercase tracking-[0.18em] text-stone-light mr-1.5">
                在播
              </span>
              <span
                className={cn(
                  'font-serif text-[13px]',
                  groupName ? 'text-stone' : 'text-stone-light italic'
                )}
              >
                {groupName ?? '未选组'}
                {groupName && playingContents != null && ` · ${playingContents} 项`}
              </span>
            </p>

            <div className="mt-2 flex items-center gap-3.5 text-[12px] text-stone">
              {online ? (
                <>
                  <span className={cn('flex items-center gap-1.5', lowBattery && 'text-clay')}>
                    <BatteryIcon size={14} />
                    <span className="font-mono tabular-nums">
                      {battery != null ? `${battery}%` : '—'}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Wifi size={14} />
                    <span>{rssiLabel(device.rssi_dbm)}</span>
                  </span>
                  <span className="text-stone-light text-[11px] ml-auto">刚刚</span>
                </>
              ) : (
                <span className="text-stone-light text-[11px]">
                  上次心跳 {timeAgo(device.last_seen_at)}
                </span>
              )}
            </div>
          </div>
        </div>
      </button>

      <div className="px-2 py-2 border-t border-line flex items-center min-h-[38px]">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="拖拽排序"
          title="拖拽排序"
          className="p-1.5 text-stone-light hover:text-ink hover:bg-cream transition-colors cursor-grab active:cursor-grabbing touch-none"
        >
          <GripVertical size={14} />
        </button>

        <span className="flex-1" />

        <button
          type="button"
          onClick={onUnbind}
          disabled={unbind.isPending}
          aria-label="解绑"
          title="从账号解绑"
          className="p-1.5 text-stone hover:text-clay hover:bg-cream transition-colors disabled:opacity-50"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
