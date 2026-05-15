import { useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Pencil, Trash2 } from 'lucide-react';
import type { ContentSummaryT } from 'shared';
import { useContentImage, useDeleteContent } from '../lib/queries';
import { AudioPlayPreview } from './AudioPlayPreview';
import { useConfirm } from './Confirm';
import { useToast } from './Toast';
import { ContentCardShell } from './content-card/ContentCardShell';
import { useContentBitmap } from './content-card/useContentBitmap';

interface ImageContentCardProps {
  gid: string;
  content: ContentSummaryT;
  onEdit: () => void;
}

export function ImageContentCard({ gid, content, onEdit }: ImageContentCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const img = useContentImage(content.content_id, content.image_etag);
  const del = useDeleteContent(gid);
  const confirm = useConfirm();
  const toast = useToast();
  useContentBitmap(canvasRef, img.data, content.image_etag);

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
        ? `「${content.title}」连同图${content.audio_etag ? '与音频' : ''}一起删除，不可逆。`
        : `这项内容的图${content.audio_etag ? '与音频' : ''}会删除，不可逆。`,
      destructive: true,
      confirmText: '删除',
    });
    if (!ok) return;
    del.mutate(content.content_id, {
      onSuccess: () => toast.success('已删除'),
      onError: () => toast.error('删除失败'),
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
        content.audio_etag ? (
          <span className="absolute top-2 right-2 bg-paper border border-ink text-ink px-1.5 font-mono text-[10px] pointer-events-none">
            ♪
          </span>
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

          {content.audio_etag && (
            <AudioPlayPreview contentId={content.content_id} etag={content.audio_etag} />
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
