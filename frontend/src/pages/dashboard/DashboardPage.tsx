// 总览 — 设备 + 内容都在此处。
//
// /devices/:did 作为 deep link：命中时自动打开对应 DeviceModal，
//   关闭后用 navigate('/') 回到无参数 URL。
//
// 设备点卡 → 弹 modal（无 URL 跳转，留在列表上下文）
// 组点卡   → /groups/:gid 进帧管理

import { useCallback, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MonitorSmartphone, Cpu } from 'lucide-react';
import { useDevices, useReorderDevices } from '@/features/devices/queries';
import { useAuth } from '@/features/auth/auth';
import { useGroups } from '@/features/groups/queries';
import { Section } from '@/components/layout/Section';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SortableGrid } from '@/components/ui/SortableGrid';
import { DeviceModal } from '@/features/devices/components/DeviceModal';
import { AddDeviceDialog } from '@/features/devices/components/AddDeviceDialog';
import { DeviceCard } from '@/features/devices/components/DeviceCard';
import { GroupsSection } from './GroupsSection';
import { useToast } from '@/components/feedback/Toast';
import { useDndOrder } from '@/lib/dnd';
import { greeting } from '@/lib/format';

export function DashboardPage() {
  const { user } = useAuth();
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

  const greetName = user?.username ?? '';

  // 设备拖拽排序
  const reorderDevices = useReorderDevices();
  const toast = useToast();
  const dnd = useDndOrder(
    devices.data,
    useCallback((d) => d.id, []),
    (newOrder, { commit, rollback }) =>
      reorderDevices.mutate(
        { order: newOrder },
        {
          onSuccess: commit,
          onError: () => {
            rollback();
            toast.error('排序保存失败');
          },
        }
      )
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
          <SortableGrid
            sensors={dnd.sensors}
            order={dnd.currentOrder}
            items={dnd.orderedItems}
            onDragEnd={dnd.onDragEnd}
            getKey={(device) => device.id}
            className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 fade-up fade-up-1"
            renderItem={(device) => (
              <DeviceCard
                device={device}
                groups={groups.data ?? []}
                onOpen={() => navigate(`/devices/${device.id}`)}
              />
            )}
          />
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
      <GroupsSection groups={groups.data} isPending={groups.isPending} />

      {/* 设备 modal */}
      {openDevice && (
        <DeviceModal
          open
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
