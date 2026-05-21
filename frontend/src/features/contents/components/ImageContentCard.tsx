import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Pencil, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import type { ContentSummaryT } from 'shared';
import { useContentImage, useDeleteContent } from '@/features/contents/queries';
import { AudioPlayPreview } from './AudioPlayPreview';
import { AudioStatusBadge } from './AudioStatusBadge';
import { useConfirm } from '@/components/feedback/Confirm';
import { useToast } from '@/components/feedback/Toast';
import { ContentCardShell } from './content-card/ContentCardShell';
import { FrameBitmapPreview } from '@/features/contents/components/FrameBitmapPreview';

interface ImageContentCardProps {
  gid: string;
  content: ContentSummaryT;
  onEdit: () => void;
}

export function ImageContentCard({ gid, content, onEdit }: ImageContentCardProps) {
  const del = useDeleteContent(gid);
  const confirm = useConfirm();
  const toast = useToast();
  const img = useContentImage(content.id, content.image_etag);

  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: content.id,
    animateLayoutChanges: () => false,
  });
  const style = useMemo(
    () => ({
      transform: CSS.Transform.toString(transform),
      transition: 'none',
      zIndex: isDragging ? 10 : undefined,
    }),
    [isDragging, transform]
  );

  async function onDelete() {
    const ok = await confirm({
      title: `删除第 ${content.seq + 1} 项？`,
      description: content.frame_name
        ? `「${content.frame_name}」连同图${content.audio_etag ? '与音频' : ''}一起删除，不可逆。`
        : `这项内容的图${content.audio_etag ? '与音频' : ''}会删除，不可逆。`,
      destructive: true,
      confirmText: '删除',
    });
    if (!ok) return;
    del.mutate(content.id, {
      onSuccess: () => toast.success('已删除'),
      onError: () => toast.error('删除失败'),
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
      topRight={<AudioStatusBadge status={content.audio_status} etag={content.audio_etag} />}
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
