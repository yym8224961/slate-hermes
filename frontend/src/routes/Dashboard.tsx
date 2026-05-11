// 总览 — 设备 + 内容都在此处。
//
// /devices/:did 作为 deep link：命中时自动打开对应 DeviceModal，
//   关闭后用 navigate('/') 回到无参数 URL。
//
// 设备点卡 → 弹 modal（无 URL 跳转，留在列表上下文）
// 组点卡   → /groups/:gid 进帧管理

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, FolderHeart, MonitorSmartphone, Cpu } from 'lucide-react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import {
  useDevices,
  useGroups,
  useMe,
  useCreateGroup,
  useDeleteGroup,
  useReorderGroups,
  useReorderDevices,
} from '../lib/queries';
import { Section } from '../components/Section';
import { Spinner } from '../components/Spinner';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { DeviceModal } from '../components/DeviceModal';
import { AddDeviceDialog } from '../components/AddDeviceDialog';
import { DeviceCard } from '../components/DeviceCard';
import { GroupCardSortable } from '../components/GroupCard';
import { CreateGroupDialog } from '../components/CreateGroupDialog';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { useDndOrder } from '../lib/dnd';
import { greeting } from '../lib/format';

export function Dashboard() {
  const me = useMe();
  const devices = useDevices();
  const groups = useGroups();
  const navigate = useNavigate();
  const { did } = useParams();

  const openDevice = devices.data?.find((d) => d.id === did);

  function closeDeviceModal() {
    navigate('/', { replace: true });
  }

  // 添加设备弹窗
  const [addOpen, setAddOpen] = useState(false);

  const greetName = me.data?.username ?? '';

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
        <h1 className="font-serif text-[36px] sm:text-[48px] font-bold leading-[1.1] tracking-tight text-ink">
          {greeting()}，<em className="not-italic">{greetName || '你好'}</em>
        </h1>
      </header>

      {/* 设备 */}
      <Section
        title="设备"
        badge={<MonitorSmartphone size={18} />}
        subtitle="设备通过 WiFi 连接，自动同步显示内容"
        action={
          <Button onClick={() => setAddOpen(true)} iconLeft={<Cpu size={14} />} size="sm">
            添加设备
          </Button>
        }
      >
        {devices.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner label="加载中" />
          </div>
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
                    onOpen={() => navigate(`/devices/${d.id}`)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <EmptyState
            icon={<MonitorSmartphone size={26} />}
            title="尚无设备"
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
      subtitle="支持图片和音频，音频会随图片同步播放"
      action={
        <Button onClick={() => setCreateOpen(true)} iconLeft={<Plus size={16} />} size="sm">
          新建组
        </Button>
      }
    >
      {groups.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner label="加载中" />
        </div>
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
                      title: `删除「${g.name}」？`,
                      description: `这一组连同 ${g.frame_count} 帧的图片与音频会全部删除，不可逆。`,
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
          hint="新建组开始上传图片。设备会按顺序循环显示。"
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
        onCreate={async (name) => {
          try {
            await create.mutateAsync({ name });
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
