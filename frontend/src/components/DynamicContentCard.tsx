import { useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertCircle, GripVertical, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { ContentDetailT } from 'shared';
import { useContentImage, useDeleteContent, useRefreshDynamicContent } from '../lib/queries';
import { useConfirm } from './Confirm';
import { useToast } from './Toast';
import { ContentCardShell } from './content-card/ContentCardShell';
import { useContentBitmap } from './content-card/useContentBitmap';

interface DynamicContentCardProps {
  gid: string;
  content: ContentDetailT;
  onEdit: () => void;
}

const DYNAMIC_LABEL: Record<string, string> = {
  date: '日期',
  weather: '天气',
  history_today: '历史',
  dashboard: '数据',
};

export function DynamicContentCard({ gid, content, onEdit }: DynamicContentCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const img = useContentImage(content.content_id, content.image_etag);
  const del = useDeleteContent(gid);
  const refresh = useRefreshDynamicContent(gid);
  const confirm = useConfirm();
  const toast = useToast();
  useContentBitmap(canvasRef, img.data, content.image_etag);

  const typeLabel = content.dynamic_type
    ? (DYNAMIC_LABEL[content.dynamic_type] ?? content.dynamic_type)
    : '动态';
  const hasError = !!content.dynamic_render_error;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: content.content_id,
    animateLayoutChanges: () => false,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: 'none',
    zIndex: isDragging ? 10 : undefined,
  };

  async function onDelete() {
    const ok = await confirm({
      title: `删除第 ${content.seq + 1} 项？`,
      description: content.title
        ? `「${content.title}」动态内容会一并删除，不可逆。`
        : '这项动态内容会删除，不可逆。',
      destructive: true,
      confirmText: '删除',
    });
    if (!ok) return;
    del.mutate(content.content_id, {
      onSuccess: () => toast.success('已删除'),
      onError: () => toast.error('删除失败'),
    });
  }

  function onRefresh() {
    refresh.mutate(content.content_id, {
      onSuccess: () => toast.success('已刷新'),
      onError: () => toast.error('刷新失败'),
    });
  }

  return (
    <ContentCardShell
      nodeRef={setNodeRef}
      style={style}
      isDragging={isDragging}
      canvasRef={canvasRef}
      loading={img.isPending}
      error={!!img.error}
      title={content.title}
      seq={content.seq}
      topRight={
        <span className="absolute top-2 right-2 bg-ink text-paper px-1.5 font-mono text-[10px] tracking-[0.12em] pointer-events-none">
          {typeLabel}
        </span>
      }
      bottomRight={
        hasError ? (
          <span
            className="absolute bottom-2 right-2 bg-clay text-paper px-1.5 py-0.5 font-mono text-[10px] flex items-center gap-1 pointer-events-none"
            title={content.dynamic_render_error ?? undefined}
          >
            <AlertCircle size={10} />
            出错
          </span>
        ) : undefined
      }
      titleMeta={
        hasError ? (
          <p
            className="font-sans text-[11px] text-clay truncate mt-0.5"
            title={content.dynamic_render_error ?? undefined}
          >
            {content.dynamic_render_error}
          </p>
        ) : undefined
      }
      actions={
        <>
          <button
            {...attributes}
            {...listeners}
            aria-label="拖拽排序"
            title="拖拽排序"
            className="p-1.5 text-stone-light hover:text-ink hover:bg-cream transition-colors cursor-grab active:cursor-grabbing touch-none"
          >
            <GripVertical size={14} />
          </button>

          <button
            onClick={onRefresh}
            aria-label="立即刷新"
            title="立即刷新"
            disabled={refresh.isPending}
            className="p-1.5 text-stone hover:text-ink hover:bg-cream transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : undefined} />
          </button>

          <span className="flex-1" />

          <button
            onClick={onEdit}
            aria-label="编辑"
            title="编辑"
            className="p-1.5 text-stone hover:text-ink hover:bg-cream transition-colors"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={onDelete}
            aria-label="删除"
            title="删除"
            className="p-1.5 text-stone hover:text-clay hover:bg-cream transition-colors"
          >
            <Trash2 size={14} />
          </button>
        </>
      }
    />
  );
}

export { DYNAMIC_LABEL };
