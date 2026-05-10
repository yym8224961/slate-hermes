// 总览 — 设备 + 内容都在此处。
//
// /devices/:did 作为 deep link:命中时自动打开对应 DeviceModal,
//   关闭后用 navigate('/') 回到无参数 URL。
//
// 设备点卡 → 弹 modal(无 URL 跳转,留在列表上下文)
// 组点卡   → /groups/:gid 进帧管理

import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  Plus,
  Wifi,
  Battery,
  BatteryWarning,
  BatteryCharging,
  ArrowRight,
  Frame,
  FolderHeart,
  MonitorSmartphone,
  Layers,
  Webhook,
  Trash2,
  GripVertical,
  Cpu,
  Check,
} from 'lucide-react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as Dialog from '@radix-ui/react-dialog';
import {
  useDevices,
  useGroups,
  useMe,
  useCreateGroup,
  useDeleteGroup,
  useReorderGroups,
  useUnbindDevice,
  useReorderDevices,
} from '../lib/queries';
import type { DeviceSummaryT, GroupSummaryT } from 'shared';
import { Section } from '../components/Section';
import { Spinner } from '../components/Spinner';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { IconBlock } from '../components/IconBlock';
import { Input } from '../components/Input';
import { DeviceModal } from '../components/DeviceModal';
import { AddDeviceDialog } from '../components/AddDeviceDialog';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { useDndOrder } from '../lib/dnd';
import { isOnline, timeAgo, rssiLabel, greeting, formatBytes } from '../lib/format';
import { cn } from '../lib/cn';

export function Dashboard() {
  const me = useMe();
  const devices = useDevices();
  const groups = useGroups();
  const navigate = useNavigate();
  const { did } = useParams();

  // 当前打开 modal 的 deviceId(优先用 URL 参,否则用本地 state)
  const [openDeviceId, setOpenDeviceId] = useState<string | null>(null);
  useEffect(() => {
    if (did) setOpenDeviceId(did);
  }, [did]);
  const openDevice = devices.data?.find((d) => d.id === openDeviceId);

  // modal 关闭:既清本地,也把 URL 回正
  function closeDeviceModal() {
    setOpenDeviceId(null);
    if (did) navigate('/', { replace: true });
  }

  // 添加设备弹窗
  const [addOpen, setAddOpen] = useState(false);

  const greetName = me.data?.email?.split('@')[0] ?? '';

  // 设备拖拽排序
  const reorderDevices = useReorderDevices();
  const toast = useToast();
  const dnd = useDndOrder(
    devices.data,
    (d) => d.id,
    (newOrder) =>
      reorderDevices.mutate({ order: newOrder }, { onError: () => toast.error('排序保存失败') })
  );

  return (
    <div>
      <header className="pb-2 fade-up">
        <h1 className="font-kai text-[32px] sm:text-[40px] leading-[1.15] text-ink">
          {greeting()},{greetName || '你好'}
        </h1>
      </header>

      {/* 设备 */}
      <Section
        title="设备"
        badge={<MonitorSmartphone size={18} />}
        action={
          <Button onClick={() => setAddOpen(true)} iconLeft={<Cpu size={14} />} size="sm">
            添加设备
          </Button>
        }
      >
        {devices.isPending ? (
          <Spinner label="加载中" />
        ) : devices.data && devices.data.length > 0 ? (
          <DndContext
            sensors={dnd.sensors}
            collisionDetection={closestCenter}
            onDragEnd={dnd.onDragEnd}
          >
            <SortableContext items={dnd.currentOrder} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 fade-up fade-up-1">
                {devices.data.map((d) => (
                  <DeviceCard
                    key={d.id}
                    device={d}
                    groups={groups.data ?? []}
                    onOpen={() => setOpenDeviceId(d.id)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <EmptyState
            icon={<MonitorSmartphone size={26} />}
            title="尚无设备"
            hint="输入 MAC 即可绑定到当前账号,设备未联网也能先添加。"
            action={
              <Button onClick={() => setAddOpen(true)} iconLeft={<Cpu size={16} />}>
                添加第一台
              </Button>
            }
          />
        )}
      </Section>

      {/* 内容 */}
      <GroupsSection />

      {/* 设备 modal */}
      {openDevice && (
        <DeviceModal
          open={!!openDevice}
          onOpenChange={(o) => {
            if (!o) closeDeviceModal();
          }}
          device={openDevice}
        />
      )}

      <AddDeviceDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

// ───────────── DeviceCard ─────────────
// 骨架与 GroupCard 完全对称:
//   [上半: 状态信息也在这,整卡可点弹 modal]
//   [footer: grip 拖动 + trash 解绑]
function DeviceCard({
  device,
  groups,
  onOpen,
}: {
  device: DeviceSummaryT;
  groups: GroupSummaryT[];
  onOpen: () => void;
}) {
  const online = isOnline(device);
  const groupName = groups.find((g) => g.id === device.selected_group_id)?.name;
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

  // 拖拽
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: device.id,
    animateLayoutChanges: () => false,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: 'none',
    zIndex: isDragging ? 10 : undefined,
  };

  // 当前在播组的帧数(派生自 groups join)
  const currentGroup = groups.find((g) => g.id === device.selected_group_id);
  const playingFrames = currentGroup?.frame_count;

  async function onUnbind(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const ok = await confirm({
      title: '解绑这台设备?',
      description: `${device.name ?? device.mac} 将从你的账号移除。素材保留,设备屏会切回配对码状态。`,
      destructive: true,
      confirmText: '解绑',
    });
    if (!ok) return;
    unbind.mutate(device.id, {
      onSuccess: () => toast.success('已解绑', '设备屏会显示新配对码'),
      onError: () => toast.error('解绑失败'),
    });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'craft-card flex flex-col overflow-hidden',
        isDragging && 'shadow-[0_16px_40px_rgba(61,40,23,0.25)] opacity-90'
      )}
      data-hoverable="true"
    >
      {/* 上半:整张可点弹 modal */}
      <button
        onClick={onOpen}
        className="block w-full text-left px-5 pt-5 pb-4 sm:px-6 sm:pt-6 sm:pb-4 hover:bg-cream-deep/40 transition-colors"
      >
        <div className="flex items-start gap-3">
          <IconBlock tone="soft">
            <Frame size={18} />
          </IconBlock>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-kai text-[20px] leading-tight truncate">
                {device.name ?? '未命名'}
              </h3>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-stone flex-shrink-0">
                <span className={cn('dot', online ? 'dot-online' : 'dot-offline')} />
                {online ? '在线' : '离线'}
              </span>
            </div>

            {/* 设备 ID — 紧贴标题的 mono 副行,与 GroupCard 的 etag 风格一致 */}
            <p className="font-mono text-[11px] text-stone-light mt-1 truncate">
              {device.id.slice(0, 12)}
            </p>

            {/* 在播 + 帧数 — 在播组后面拼"· N 帧"显示组的体量 */}
            <p className="font-kai text-[13px] mt-2 truncate">
              <span className="text-stone-light mr-1.5">在播</span>
              <span className={groupName ? 'text-stone' : 'text-stone-light italic'}>
                {groupName ?? '未选组'}
              </span>
              {groupName && playingFrames != null && (
                <span className="text-stone-light"> · {playingFrames} 帧</span>
              )}
            </p>

            {/* 状态行 — 在线显示电量/信号/刚刚,离线只显示上次心跳 */}
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

      {/* footer — 拖动 + 解绑,与 GroupCard footer 完全对称 */}
      <div className="px-2 py-1.5 border-t border-line bg-paper/50 flex items-center min-h-[36px]">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="拖拽排序"
          title="拖拽排序"
          className="p-1.5 text-stone-light hover:text-clay hover:bg-cream rounded-[8px] cursor-grab active:cursor-grabbing touch-none"
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
          className="p-1.5 text-stone hover:text-clay hover:bg-cream rounded-[8px] disabled:opacity-50"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

// ───────────── GroupsSection(原 /groups 列表整合进首页)─────────────
function GroupsSection() {
  const groups = useGroups();
  const create = useCreateGroup();
  const del = useDeleteGroup();
  const reorder = useReorderGroups();
  const toast = useToast();
  const confirm = useConfirm();

  const [createOpen, setCreateOpen] = useState(false);

  const { sensors, currentOrder, onDragEnd } = useDndOrder(
    groups.data,
    (g) => g.id,
    (newOrder) =>
      reorder.mutate({ order: newOrder }, { onError: () => toast.error('排序保存失败') })
  );

  return (
    <Section
      title="内容"
      badge={<FolderHeart size={18} />}
      subtitle="一组 = 一套循环画面。相册手动上传，看板由 webhook 推。"
      action={
        <Button onClick={() => setCreateOpen(true)} iconLeft={<Plus size={16} />} size="sm">
          新建组
        </Button>
      }
    >
      {groups.isPending ? (
        <Spinner label="加载中" />
      ) : groups.data && groups.data.length > 0 ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={currentOrder} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 fade-up fade-up-2">
              {groups.data.map((g) => (
                <GroupCardSortable
                  key={g.id}
                  group={g}
                  onDelete={async () => {
                    const ok = await confirm({
                      title: `删除「${g.name}」?`,
                      description: `这一组连同 ${g.frame_count} 帧的图片与音频会全部删除,不可逆。`,
                      destructive: true,
                      confirmText: '删除整组',
                    });
                    if (!ok) return;
                    del.mutate(g.id, {
                      onSuccess: () => toast.success('已删除'),
                      onError: () => toast.error('删除失败'),
                    });
                  }}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <EmptyState
          icon={<FolderHeart size={26} />}
          title="尚无内容"
          hint="新建一组开始上传图片。设备会按顺序循环显示。"
          action={
            <Button onClick={() => setCreateOpen(true)} iconLeft={<Plus size={16} />}>
              新建第一组
            </Button>
          }
        />
      )}

      <CreateGroupDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={async (name, kind) => {
          try {
            await create.mutateAsync({ name, kind });
            toast.success('已创建');
            setCreateOpen(false);
          } catch {
            toast.error('创建失败');
          }
        }}
        isPending={create.isPending}
      />
    </Section>
  );
}

// ───────────── GroupCard(可拖拽)─────────────
function GroupCardSortable({ group, onDelete }: { group: GroupSummaryT; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: group.id,
    animateLayoutChanges: () => false,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: 'none',
    zIndex: isDragging ? 10 : undefined,
  };

  const KindIcon = group.kind === 'dynamic' ? Webhook : Layers;
  const kindLabel = group.kind === 'static' ? '相册' : '看板';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'craft-card flex flex-col overflow-hidden',
        isDragging && 'shadow-[0_16px_40px_rgba(61,40,23,0.25)] opacity-90'
      )}
    >
      {/* 主区 — icon + 名 + 帧数 + 副标(总素材体积 · etag)。
          kind 用 icon 区分(Layers=相册 / Webhook=看板),hover tooltip 给文字。 */}
      <Link
        to={`/groups/${group.id}`}
        className="block flex-1 min-w-0 px-5 py-5 sm:px-6 sm:py-6 hover:bg-cream-deep/40 transition-colors"
      >
        <div className="flex items-start gap-3.5">
          <IconBlock tone="soft" title={kindLabel} aria-label={kindLabel}>
            <KindIcon size={18} />
          </IconBlock>
          <div className="min-w-0 flex-1 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-kai text-[22px] leading-tight truncate">{group.name}</h3>
              <p className="font-mono text-[11px] text-stone-light mt-1.5 truncate">
                {formatBytes(group.total_bytes)} · {group.etag.slice(0, 12)}
              </p>
            </div>
            <div className="flex items-baseline gap-1 flex-shrink-0">
              <span className="font-kai text-[26px] leading-none tabular-nums text-ink">
                {group.frame_count}
              </span>
              <span className="font-kai text-[13px] text-stone">帧</span>
            </div>
          </div>
        </div>
      </Link>

      {/* footer — 拖动 + 修改 + 删除,与 DeviceCard footer 对称 */}
      <div className="px-2 py-1.5 border-t border-line bg-paper/50 flex items-center min-h-[36px]">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="拖拽排序"
          title="拖拽排序"
          className="p-1.5 text-stone-light hover:text-clay hover:bg-cream rounded-[8px] cursor-grab active:cursor-grabbing touch-none"
        >
          <GripVertical size={14} />
        </button>

        <span className="flex-1" />

        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
          aria-label="删除"
          title="删除整组"
          className="p-1.5 text-stone hover:text-clay hover:bg-cream rounded-[8px]"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

// ───────────── CreateGroupDialog ─────────────
function CreateGroupDialog({
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
        <Dialog.Overlay className="fixed inset-0 bg-ink/30 backdrop-blur-[2px] z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-2rem)] max-w-md bg-paper border border-line rounded-[20px] z-50 p-7 shadow-[0_24px_64px_rgba(61,40,23,0.16)]">
          {/* 与 AddDeviceDialog / DeviceModal / FrameEditor 对齐:左 IconBlock + 标题/说明 */}
          <div className="flex items-start gap-3 mb-6">
            <IconBlock tone="soft">
              <FolderHeart size={18} />
            </IconBlock>
            <div className="min-w-0">
              <Dialog.Title className="font-kai text-[24px] leading-tight">新建一组</Dialog.Title>
              <Dialog.Description className="font-kai text-[13px] text-stone mt-1 leading-relaxed">
                相册手动上传,看板由 webhook 推数据。
              </Dialog.Description>
            </div>
          </div>

          <div className="space-y-5">
            <Input
              label="名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="如:每日卡片"
            />

            <div>
              <p className="block font-sans text-[12px] text-stone mb-2 ml-0.5">类型</p>
              <div className="grid grid-cols-2 gap-3">
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
                        'relative text-left px-4 py-3.5 rounded-[14px] border-2 transition-all',
                        // 选中:浅砖红填充 + 砖红描边 + 砖红字 + 右上勾标。
                        // 不用 bg-clay 实色 + paper 字 — 那个组合在 cream 页底上文字会消失。
                        active
                          ? 'bg-clay/10 border-clay text-clay shadow-[0_3px_10px_-2px_rgba(184,84,54,0.18)]'
                          : 'bg-cream-deep/60 border-stone-light/40 text-stone hover:border-stone hover:text-ink hover:bg-cream-deep'
                      )}
                    >
                      {active && (
                        <span className="absolute top-2.5 right-2.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-clay text-paper">
                          <Check size={12} strokeWidth={3} />
                        </span>
                      )}
                      <Icon size={20} className={active ? 'text-clay' : 'text-stone-light'} />
                      <p
                        className={cn(
                          'font-kai text-[16px] mt-2',
                          active ? 'text-clay' : 'text-ink'
                        )}
                      >
                        {k === 'static' ? '静态相册' : '动态看板'}
                      </p>
                      <p
                        className={cn(
                          'font-sans text-[11px] mt-1 leading-tight',
                          active ? 'text-clay/75' : 'text-stone'
                        )}
                      >
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
