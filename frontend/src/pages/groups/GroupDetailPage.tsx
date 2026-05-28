// 组详情：metadata + 内容网格（拖拽排序 + 试听/编辑/删除）+ 顶部「新增」。
//
// dnd-kit reorder 通过 useDndOrder 复用；本地顺序会在保存失败时回滚。

import { useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Layers, Pencil, Check } from 'lucide-react';
import { useGroup, useUpdateGroup } from '@/features/groups/queries';
import { useGroupContents, useReorderContents } from '@/features/contents/queries';
import type { ContentDetailT, GroupSummaryT } from 'shared';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SortableGrid } from '@/components/ui/SortableGrid';
import { ImageContentCard } from '@/features/contents/components/cards/ImageContentCard';
import { DynamicContentCard } from '@/features/contents/components/cards/DynamicContentCard';
import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/feedback/Toast';
import { inputCls } from '@/lib/styles';
import { cn } from '@/lib/cn';
import { useInlineRename } from '@/lib/hooks';
import { formatBytes } from '@/lib/format';
import { useDndOrder } from '@/lib/dnd';

export function GroupDetailPage() {
  const { gid } = useParams();
  const navigate = useNavigate();
  const groupQuery = useGroup(gid);
  const contents = useGroupContents(gid);
  const reorder = useReorderContents(gid);
  const toast = useToast();

  const group = groupQuery.data;
  const { sensors, currentOrder, orderedItems, onDragEnd } = useDndOrder(
    contents.data,
    useCallback((f) => f.id, []),
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

  if (!gid) {
    return (
      <EmptyState
        title="页面不存在"
        hint="请从总览页进入具体内容组。"
        action={
          <Link
            to="/"
            className="inline-flex items-center gap-1 text-[13px] text-stone border-b border-stone"
          >
            <ArrowLeft size={13} /> 返回总览
          </Link>
        }
      />
    );
  }
  if (groupQuery.isPending) {
    return (
      <div className="pt-16 text-center">
        <Spinner label="加载中" />
      </div>
    );
  }
  if (groupQuery.isError || !group) {
    return (
      <EmptyState
        title="内容不存在或已被删除"
        action={
          <Link
            to="/"
            className="inline-flex items-center gap-1 text-[13px] text-stone border-b border-stone"
          >
            <ArrowLeft size={13} /> 返回总览
          </Link>
        }
      />
    );
  }

  const KindIcon = Layers;

  function openCreate() {
    navigate(`/groups/${gid}/contents/new`);
  }
  function openEdit(f: ContentDetailT) {
    if (f.kind === 'dynamic') {
      navigate(`/groups/${gid}/contents/dynamic/${f.id}/edit`);
    } else {
      navigate(`/groups/${gid}/contents/image/${f.id}/edit`);
    }
  }

  return (
    <div>
      <GroupHeader
        group={group}
        KindIcon={KindIcon}
        onBack={() => navigate('/')}
        onAdd={openCreate}
      />
      <div className="mt-6 fade-up fade-up-1">
        {contents.isPending ? (
          <Spinner label="加载中" />
        ) : contents.isError ? (
          <EmptyState title="加载失败" hint="请刷新重试。" />
        ) : contents.data && contents.data.length > 0 ? (
          <SortableGrid
            sensors={sensors}
            order={currentOrder}
            items={orderedItems}
            onDragEnd={onDragEnd}
            getKey={(content) => content.id}
            className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
            renderItem={(content) =>
              content.kind === 'dynamic' ? (
                <DynamicContentCard gid={gid} content={content} onEdit={() => openEdit(content)} />
              ) : (
                <ImageContentCard gid={gid} content={content} onEdit={() => openEdit(content)} />
              )
            }
          />
        ) : (
          <EmptyState
            title="尚无内容"
            hint="点击新建帧开始添加内容。"
            action={
              <Button onClick={openCreate} iconLeft={<Plus size={16} />}>
                新建帧
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}

// ───── 组标题 + inline 改名 + 新建内容 ───────────────────────────
function GroupHeader({
  group,
  KindIcon,
  onBack,
  onAdd,
}: {
  group: GroupSummaryT;
  KindIcon: typeof Layers;
  onBack: () => void;
  onAdd: () => void;
}) {
  const update = useUpdateGroup(group.id);
  const toast = useToast();

  const { editing, draft, setDraft, startEditing, commit, handleKeyDown } = useInlineRename(
    group.name,
    async (name) => {
      try {
        await update.mutateAsync({ name });
        toast.success('已改名');
      } catch (err) {
        toast.error('改名失败');
        throw err;
      }
    }
  );

  return (
    <PageHeader
      backLabel="总览"
      onBack={onBack}
      icon={<KindIcon size={24} />}
      title={group.name}
      titleContent={
        <div className="flex items-center gap-2 min-w-0">
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={handleKeyDown}
              maxLength={64}
              className={cn(
                inputCls,
                'flex-1 min-w-0 !font-serif !font-bold !text-[32px] sm:!text-[40px] !leading-[1.2]'
              )}
            />
          ) : (
            <h1 className="font-serif text-[32px] sm:text-[40px] font-bold leading-[1.2] truncate tracking-tight">
              {group.name}
            </h1>
          )}
          <button
            onClick={() => (editing ? commit() : startEditing())}
            disabled={update.isPending}
            aria-label={editing ? '保存名称' : '改名'}
            title={editing ? '保存' : '改名'}
            className="text-stone-light hover:text-ink disabled:opacity-50 transition-colors p-2 -m-1 hover:bg-cream flex-shrink-0"
          >
            {editing ? <Check size={18} /> : <Pencil size={16} />}
          </button>
        </div>
      }
      subtitle={`${group.content_count} 项 · ${formatBytes(group.total_bytes)}`}
      action={
        <Button iconLeft={<Plus size={16} />} size="sm" onClick={onAdd}>
          新建帧
        </Button>
      }
    />
  );
}
