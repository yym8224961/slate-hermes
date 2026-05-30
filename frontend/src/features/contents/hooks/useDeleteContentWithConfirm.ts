import { useCallback } from 'react';
import type { ContentSummaryT } from 'shared';
import { useConfirmAction } from '@/components/feedback/mutation-feedback';
import { useDeleteContent } from '@/features/contents/query/content-list-queries';

export function useDeleteContentWithConfirm({
  gid,
  content,
  description,
}: {
  gid: string;
  content: Pick<ContentSummaryT, 'id' | 'seq' | 'frame_name' | 'audio_etag' | 'kind'>;
  description?: string;
}) {
  const { mutate, isPending } = useDeleteContent(gid);

  const confirmDelete = useConfirmAction<string>({
    isPending,
    getConfirmOptions: useCallback(
      () => ({
        title: `删除第 ${content.seq + 1} 项？`,
        description: description ?? defaultDeleteDescription(content),
        destructive: true,
        confirmText: '删除',
      }),
      [content, description]
    ),
    run: useCallback((contentId, callbacks) => mutate(contentId, callbacks), [mutate]),
    successToast: '已删除',
    errorToast: '删除失败',
  });
  const deleteWithConfirm = useCallback(() => {
    void confirmDelete(content.id);
  }, [confirmDelete, content.id]);

  return { deleteWithConfirm, isPending };
}

function defaultDeleteDescription(
  content: Pick<ContentSummaryT, 'frame_name' | 'audio_etag' | 'kind'>
): string {
  if (content.kind === 'dynamic') {
    return content.frame_name
      ? `「${content.frame_name}」动态内容会一并删除，不可逆。`
      : '这项动态内容会删除，不可逆。';
  }
  return content.frame_name
    ? `「${content.frame_name}」连同图${content.audio_etag ? '与音频' : ''}一起删除，不可逆。`
    : `这项内容的图${content.audio_etag ? '与音频' : ''}会删除，不可逆。`;
}
