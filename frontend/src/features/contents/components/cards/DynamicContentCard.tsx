import { AlertCircle, RefreshCw } from 'lucide-react';
import type { ContentDetailT } from 'shared';
import { DragHandle } from '@/components/ui/DragHandle';
import { useContentImage, useRefreshDynamicContent } from '@/features/contents/queries';
import { useToast } from '@/components/feedback/Toast';
import { AudioPlayPreview } from '../audio/AudioPlayPreview';
import { AudioStatusBadge } from './AudioStatusBadge';
import { ContentCardActions } from './ContentCardActions';
import { ContentCardShell } from './ContentCardShell';
import { useDeleteContentWithConfirm } from './useDeleteContentWithConfirm';
import { FrameBitmapPreview } from '@/features/contents/components/preview/FrameBitmapPreview';
import { useSortableStyle } from '@/lib/dnd';

interface DynamicContentCardProps {
  gid: string;
  content: ContentDetailT;
  onEdit: () => void;
}

export function DynamicContentCard({ gid, content, onEdit }: DynamicContentCardProps) {
  const refresh = useRefreshDynamicContent(gid);
  const toast = useToast();
  const { deleteWithConfirm, isPending: deletePending } = useDeleteContentWithConfirm({
    gid,
    content,
  });

  const img = useContentImage(content.id, content.image_etag);
  const hasRenderError = !!content.dynamic_render_error;

  const { attributes, listeners, setNodeRef, style, isDragging } = useSortableStyle(content.id);

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
        <ContentCardActions
          dragHandle={<DragHandle attributes={attributes} listeners={listeners} />}
          extraActions={
            <button
              type="button"
              onClick={onRefresh}
              aria-label="立即刷新"
              title="立即刷新"
              disabled={refresh.isPending}
              className="p-1.5 text-stone hover:text-ink hover:bg-cream transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : undefined} />
            </button>
          }
          audioPreview={
            content.audio_etag ? (
              <AudioPlayPreview contentId={content.id} etag={content.audio_etag} />
            ) : null
          }
          onEdit={onEdit}
          onDelete={deleteWithConfirm}
          deleteDisabled={deletePending}
        />
      }
    />
  );
}
