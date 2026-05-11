// 组详情：metadata + 帧网格（拖拽排序 + 试听/编辑/删除）+ 顶部「新增帧」。
//
// dnd-kit reorder 通过 useDndOrder 复用；optimistic update 仍在本地处理，
// 因为 server 接受的是「旧 idx 的新顺序」，不是 etag 列表。

import { useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Layers, Frame, Pencil, Check } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy } from '@dnd-kit/sortable';
import { useGroups, useGroupFrames, useReorderFrames, useUpdateGroup } from '../lib/queries';
import type { GroupSummaryT } from 'shared';
import type { FrameSummaryT as FT } from 'shared';
import { Spinner } from '../components/Spinner';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { IconBlock } from '../components/IconBlock';
import { FrameCard } from '../components/FrameCard';
import { DoubleRule } from '../components/DoubleRule';
import { useToast } from '../components/Toast';
import { inputCls } from '../lib/styles';
import { cn } from '../lib/cn';
import { useInlineRename } from '../lib/hooks';
import { formatBytes } from '../lib/format';

export function GroupDetail() {
  const { gid } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const groups = useGroups();
  const frames = useGroupFrames(gid);
  const reorder = useReorderFrames(gid ?? '');
  const toast = useToast();

  const group = useMemo(() => groups.data?.find((g) => g.id === gid), [groups.data, gid]);
  const orderIds = useMemo(() => (frames.data ?? []).map((f) => f.image_etag), [frames.data]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // 帧排序需要「旧 idx 的新顺序」作为 server 入参，不能直接用 useDndOrder
  // 的纯 etag 列表 — 这里保留独立逻辑。
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;

    const cur = qc.getQueryData<FT[]>(['frames', gid]);
    if (!cur) {
      toast.error('排序失败，请刷新重试');
      return;
    }

    const oldPos = cur.findIndex((f) => f.image_etag === active.id);
    const newPos = cur.findIndex((f) => f.image_etag === over.id);
    if (oldPos < 0 || newPos < 0) return;

    const reordered = arrayMove(cur, oldPos, newPos);
    const newSeqOrder = reordered.map((f) => f.sort_order);
    const optimistic: FT[] = reordered.map((f, i) => ({ ...f, sort_order: i }));

    qc.setQueryData(['frames', gid], optimistic);
    reorder.mutate(
      { order: newSeqOrder },
      {
        onError: () => {
          toast.error('排序保存失败');
          qc.invalidateQueries({ queryKey: ['frames', gid] });
        },
      }
    );
  }

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
  if (groups.isPending) {
    return (
      <div className="pt-16 text-center">
        <Spinner label="加载中" />
      </div>
    );
  }
  if (!group) {
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
    navigate(`/groups/${gid}/frames/new`);
  }
  function openEdit(f: FT) {
    navigate(`/groups/${gid}/frames/${f.sort_order}/edit`);
  }

  return (
    <div>
      <nav>
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-[11px] font-mono text-stone hover:text-ink tracking-[0.08em]"
        >
          <ArrowLeft size={14} /> 总览
        </Link>
      </nav>

      <GroupHeader group={group} KindIcon={KindIcon} onAddFrame={openCreate} />

      {/* 双线分隔 */}
      <DoubleRule className="mt-3" />
      <div className="mt-6 fade-up fade-up-1">
        {frames.isPending ? (
          <Spinner label="加载中" />
        ) : frames.isError ? (
          <EmptyState title="加载失败" hint="请刷新重试。" />
        ) : frames.data && frames.data.length > 0 ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={orderIds} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {frames.data.map((f) => (
                  <FrameCard key={f.image_etag} gid={gid} frame={f} onEdit={() => openEdit(f)} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <EmptyState
            icon={<Frame size={26} />}
            title="尚无帧"
            hint="点『新建一帧』上传第一张。"
            action={
              <Button onClick={openCreate} iconLeft={<Plus size={16} />}>
                新建第一帧
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}

// ───── 组标题 + inline 改名 + 新建一帧 ───────────────────────────
function GroupHeader({
  group,
  KindIcon,
  onAddFrame,
}: {
  group: GroupSummaryT;
  KindIcon: typeof Layers;
  onAddFrame: () => void;
}) {
  const update = useUpdateGroup(group.id);
  const toast = useToast();

  const { editing, draft, setDraft, startEditing, commit, handleKeyDown } = useInlineRename(
    group.name,
    async (name) => {
      await new Promise<void>((resolve, reject) => {
        update.mutate(
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
    }
  );

  const kindLabel = '内容';

  return (
    <header className="mt-5 fade-up flex items-center gap-4">
      <IconBlock size="lg" tone="soft" title={kindLabel} aria-label={kindLabel}>
        <KindIcon size={24} />
      </IconBlock>
      <div className="flex-1 min-w-0">
        {/* 标题行：h1 + 改名 */}
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
        {/* meta 在标题下方 */}
        <p className="font-sans text-[13px] text-stone mt-1.5 leading-relaxed">
          {group.frame_count} 帧 · {formatBytes(group.total_bytes)}
        </p>
      </div>
      <Button
        onClick={onAddFrame}
        iconLeft={<Plus size={16} />}
        size="sm"
        className="flex-shrink-0"
      >
        新建一帧
      </Button>
    </header>
  );
}
