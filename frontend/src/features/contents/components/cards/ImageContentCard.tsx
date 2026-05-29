import type { ContentDetailT } from 'shared';
import { DragHandle } from '@/components/ui/DragHandle';
import { useContentImage } from '@/features/contents/queries';
import { AudioPlayPreview } from '../audio/AudioPlayPreview';
import { AudioStatusBadge } from './AudioStatusBadge';
import { ContentCardActions } from './ContentCardActions';
import { ContentCardShell } from './ContentCardShell';
import { useDeleteContentWithConfirm } from './useDeleteContentWithConfirm';
import { FrameBitmapPreview } from '@/features/contents/components/preview/FrameBitmapPreview';
import { useSortableStyle } from '@/hooks/dnd';

interface ImageContentCardProps {
  gid: string;
  content: ContentDetailT;
  onEdit: () => void;
}

export function ImageContentCard({ gid, content, onEdit }: ImageContentCardProps) {
  const { deleteWithConfirm, isPending: deletePending } = useDeleteContentWithConfirm({
    gid,
    content,
  });
  const img = useContentImage(content.id, content.image_etag);

  const { attributes, listeners, setNodeRef, style, isDragging } = useSortableStyle(content.id);

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
        <ContentCardActions
          dragHandle={<DragHandle attributes={attributes} listeners={listeners} />}
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
