import { memo, useCallback, useState } from 'react';
import { FolderHeart, Plus } from 'lucide-react';
import type { GroupSummaryT } from 'shared';
import { useCreateGroup, useDeleteGroup, useReorderGroups } from '@/features/groups/queries';
import { CreateGroupDialog } from '@/features/groups/components/CreateGroupDialog';
import { GroupCardSortable } from '@/features/groups/components/GroupCard';
import { useConfirm } from '@/components/feedback/Confirm';
import { useToast } from '@/components/feedback/Toast';
import { Section } from '@/components/layout/Section';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { SortableGrid } from '@/components/ui/SortableGrid';
import { useDndOrder } from '@/lib/dnd';

interface GroupsSectionProps {
  groups: GroupSummaryT[] | undefined;
  isPending: boolean;
}

export const GroupsSection = memo(function GroupsSection({
  groups,
  isPending,
}: GroupsSectionProps) {
  const create = useCreateGroup();
  const del = useDeleteGroup();
  const reorder = useReorderGroups();
  const toast = useToast();
  const confirm = useConfirm();

  const [createOpen, setCreateOpen] = useState(false);

  const { sensors, currentOrder, orderedItems, onDragEnd } = useDndOrder(
    groups,
    useCallback((g) => g.id, []),
    (newOrder, { commit, rollback }) =>
      reorder.mutate(
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
      {isPending ? (
        <div className="flex justify-center py-8">
          <Spinner label="加载中" />
        </div>
      ) : groups && groups.length > 0 ? (
        <SortableGrid
          sensors={sensors}
          order={currentOrder}
          items={orderedItems}
          onDragEnd={onDragEnd}
          getKey={(group) => group.id}
          className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 fade-up fade-up-2"
          renderItem={(group) => (
            <GroupCardSortable
              group={group}
              deleteDisabled={del.isPending}
              onDelete={async () => {
                if (del.isPending) return;
                const ok = await confirm({
                  title: `删除「${group.name}」？`,
                  description: `这一组连同 ${group.content_count} 项内容的图片与音频会全部删除，不可逆。`,
                  destructive: true,
                  confirmText: '删除整组',
                });
                if (!ok) return;
                del.mutate(group.id, {
                  onSuccess: () => toast.success('已删除'),
                  onError: () => toast.error('删除失败'),
                });
              }}
            />
          )}
        />
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
});
