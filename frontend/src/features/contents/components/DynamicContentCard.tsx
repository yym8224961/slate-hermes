import { AlertCircle, GripVertical, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { ContentDetailT } from 'shared';
import {
  useContentImage,
  useDeleteContent,
  useRefreshDynamicContent,
} from '@/features/contents/queries';
import { useConfirm } from '@/components/feedback/Confirm';
import { useToast } from '@/components/feedback/Toast';
import { AudioPlayPreview } from './AudioPlayPreview';
import { AudioStatusBadge } from './AudioStatusBadge';
import { ContentCardShell } from './content-card/ContentCardShell';
import { FrameBitmapPreview } from '@/features/contents/components/FrameBitmapPreview';
import { useSortableStyle } from '@/lib/dnd';

interface DynamicContentCardProps {
  gid: string;
  content: ContentDetailT;
  onEdit: () => void;
}

export function DynamicContentCard({ gid, content, onEdit }: DynamicContentCardProps) {
  const del = useDeleteContent(gid);
  const refresh = useRefreshDynamicContent(gid);
  const confirm = useConfirm();
  const toast = useToast();

  const img = useContentImage(content.id, content.image_etag);
  const hasRenderError = !!content.dynamic_render_error;

  const { attributes, listeners, setNodeRef, style, isDragging } = useSortableStyle(content.id);

  async function onDelete() {
    const ok = await confirm({
      title: `删除第 ${content.seq + 1} 项？`,
      description: content.frame_name
        ? `「${content.frame_name}」动态内容会一并删除，不可逆。`
        : '这项动态内容会删除，不可逆。',
      destructive: true,
      confirmText: '删除',
    });
    if (!ok) return;
    del.mutate(content.id, {
      onSuccess: () => toast.success('已删除'),
      onError: () => toast.error('删除失败'),
    });
  }

  function onRefresh() {
    refresh.mutate(content.id, {
      onSuccess: () => toast.success('已刷新'),
      onError: () => toast.error('刷新失败'),
    });
  }

  return (
    <ContentCardShell
      nodeRef={setNodeRef}
      style={style}
      isDragging={isDragging}
      loading={img.isPending}
      error={!!img.error}
      frameName={content.frame_name}
      seq={content.seq}
      preview={
        <FrameBitmapPreview
          data={img.data}
          cacheKey={content.image_etag}
          caption={content.device_status_bar_text}
          showStatusBar={false}
        />
      }
      topRight={
        <AudioStatusBadge
          status={content.audio_status}
          etag={content.audio_etag}
          error={content.audio_error}
        />
      }
      titleMeta={
        hasRenderError ? (
          <p
            className="mt-0.5 flex items-center gap-1 truncate font-sans text-[11px] text-clay"
            title={content.dynamic_render_error ?? undefined}
          >
            <AlertCircle size={11} className="shrink-0" />
            <span className="truncate">{content.dynamic_render_error}</span>
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

          {content.audio_etag && (
            <AudioPlayPreview contentId={content.id} etag={content.audio_etag} />
          )}

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
