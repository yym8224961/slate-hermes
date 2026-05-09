// 组详情：metadata + 帧网格（拖拽排序 + 试听/编辑/删除）+ 顶部「新增帧」。
//
// dnd-kit reorder 通过 useDndOrder 复用；optimistic update 仍在本地处理，
// 因为 server 接受的是「旧 idx 的新顺序」，不是 etag 列表。

import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Layers, Webhook, Frame, Pencil, Check } from 'lucide-react';
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
import { FrameEditor } from '../components/FrameEditor';
import { useToast } from '../components/Toast';
import { inputCls } from '../lib/styles';
import { cn } from '../lib/cn';

export function GroupDetail() {
  const { gid } = useParams();
  const qc = useQueryClient();
  const groups = useGroups();
  const frames = useGroupFrames(gid);
  const reorder = useReorderFrames(gid ?? '');
  const toast = useToast();

  const group = groups.data?.find((g) => g.id === gid);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingFrame, setEditingFrame] = useState<FT | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // 帧排序需要「旧 idx 的新顺序」作为 server 入参，不能直接用 useDndOrder
  // 的纯 etag 列表 — 这里保留独立逻辑。
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;

    const cur = qc.getQueryData<FT[]>(['frames', gid]);
    if (!cur) return;

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

  if (!gid) return null;
  if (groups.isPending) {
    return (
      <div className="pt-16 text-center">
        <Spinner label="加载中" />
      </div>
    );
  }
  if (!group) {
    return (
      <div className="pt-16 text-center">
        <p className="font-kai text-[18px] text-stone">这组内容不存在,或不属于你。</p>
        <Link to="/" className="text-[13px] text-clay mt-3 inline-block hover:underline">
          ← 返回总览
        </Link>
      </div>
    );
  }

  const KindIcon = group.kind === 'dynamic' ? Webhook : Layers;

  function openCreate() {
    setEditingFrame(null);
    setEditorOpen(true);
  }
  function openEdit(f: FT) {
    setEditingFrame(f);
    setEditorOpen(true);
  }

  const orderIds = (frames.data ?? []).map((f) => f.image_etag);

  return (
    <div>
      <nav>
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-[13px] text-stone hover:text-clay"
        >
          <ArrowLeft size={14} /> 总览
        </Link>
      </nav>

      <GroupHeader group={group} KindIcon={KindIcon} onAddFrame={openCreate} />

      {/* 不再有「帧」小标题（组名已是页面标题，重复），但保留波浪分割线。
          mt-5 与 Section 组件 header→wave 间距一致。 */}
      <div className="wave-divider mt-5" />
      <div className="mt-6 fade-up fade-up-1">
        {frames.isPending ? (
          <Spinner label="加载中" />
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
            hint="点『新建一帧』上传第一张。设备配网后会自动拉到本地缓存。"
            action={
              <Button onClick={openCreate} iconLeft={<Plus size={16} />}>
                新建第一帧
              </Button>
            }
          />
        )}
      </div>

      <FrameEditor
        open={editorOpen}
        onOpenChange={(o) => {
          setEditorOpen(o);
          if (!o) setEditingFrame(null);
        }}
        gid={gid}
        frame={editingFrame ?? undefined}
      />
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);

  useEffect(() => {
    setDraft(group.name);
    setEditing(false);
  }, [group.id, group.name]);

  function commit() {
    const next = draft.trim();
    if (!next || next === group.name) {
      setEditing(false);
      setDraft(group.name);
      return;
    }
    update.mutate(
      { name: next },
      {
        onSuccess: () => {
          toast.success('已改名');
          setEditing(false);
        },
        onError: () => {
          toast.error('改名失败');
          setDraft(group.name);
        },
      }
    );
  }

  const kindLabel = group.kind === 'static' ? '相册' : '看板';

  return (
    <header className="mt-5 fade-up flex items-center gap-4">
      <IconBlock size="xl" tone="soft" title={kindLabel} aria-label={kindLabel}>
        <KindIcon size={28} />
      </IconBlock>

      {/* 右侧:标题在上、meta 在下;按钮浮在最右 */}
      <div className="flex-1 min-w-0 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') {
                    setEditing(false);
                    setDraft(group.name);
                  }
                }}
                maxLength={64}
                className={cn(
                  inputCls,
                  'flex-1 min-w-0 !font-kai !text-[32px] sm:!text-[40px] leading-tight !py-1'
                )}
              />
            ) : (
              <h1 className="font-kai text-[32px] sm:text-[40px] leading-tight truncate">
                {group.name}
              </h1>
            )}
            <button
              onClick={() => (editing ? commit() : setEditing(true))}
              disabled={update.isPending}
              aria-label={editing ? '保存名称' : '改名'}
              title={editing ? '保存' : '改名'}
              className="text-stone-light hover:text-clay disabled:opacity-50 transition-colors p-2 -m-1 rounded-[8px] hover:bg-cream flex-shrink-0"
            >
              {editing ? <Check size={18} /> : <Pencil size={16} />}
            </button>
          </div>

          {/* meta 在标题下方 */}
          <p className="font-kai text-[14px] text-stone mt-1.5">
            {kindLabel} · {group.frame_count} 帧
          </p>
        </div>

        <Button
          onClick={onAddFrame}
          iconLeft={<Plus size={16} />}
          size="sm"
          className="flex-shrink-0 mt-2"
        >
          新建一帧
        </Button>
      </div>
    </header>
  );
}
