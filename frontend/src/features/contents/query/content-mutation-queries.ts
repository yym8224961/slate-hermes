import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ContentDetailT, ContentMutationResponseT, ReorderContentsRequestT } from 'shared';
import { API_PREFIX, api } from '@/lib/http';
import { useInvalidateContentDependencies } from './content-cache-helpers';
import { contentKeys } from './keys';

export function useCreateImageContent(gid: string) {
  const invalidate = useInvalidateContentDependencies(gid);
  return useMutation({
    mutationFn: async (form: FormData) => {
      const { data } = await api.post<ContentMutationResponseT>(
        `${API_PREFIX}/groups/${gid}/contents`,
        form,
        {
          headers: { 'Content-Type': 'multipart/form-data' },
        }
      );
      return data;
    },
    onSuccess: (data) => {
      invalidate(data.id);
    },
  });
}

export function useUpdateImageContent(gid: string) {
  const invalidate = useInvalidateContentDependencies(gid);
  return useMutation({
    mutationFn: async ({ contentId, form }: { contentId: string; form: FormData }) => {
      const { data } = await api.patch<ContentMutationResponseT>(
        `${API_PREFIX}/contents/${contentId}`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      return data;
    },
    onSuccess: (data) => {
      invalidate(data.id);
    },
  });
}

export function useDeleteContent(gid: string) {
  const invalidate = useInvalidateContentDependencies(gid);
  return useMutation({
    mutationFn: async (contentId: string) => {
      await api.delete(`${API_PREFIX}/contents/${contentId}`);
      return contentId;
    },
    onSuccess: (_data, contentId) => {
      invalidate(contentId);
    },
  });
}

export function useReorderContents(gid: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateContentDependencies(gid);
  const groupKey = contentKeys.group(gid);
  return useMutation({
    mutationFn: async (body: ReorderContentsRequestT) => {
      await api.put(`${API_PREFIX}/groups/${gid}/contents/order`, body);
    },
    // 乐观更新 seq：避免拖拽落点到 refetch 完成之间 ContentCard 显示旧序号。
    onMutate: async ({ order }) => {
      await qc.cancelQueries({ queryKey: groupKey });
      const previous = qc.getQueryData<ContentDetailT[]>(groupKey);
      if (previous) {
        const byId = new Map(previous.map((c) => [c.id, c]));
        const reordered: ContentDetailT[] = order
          .map((id, idx) => {
            const item = byId.get(id);
            return item ? { ...item, seq: idx } : undefined;
          })
          .filter((c): c is ContentDetailT => c !== undefined);
        qc.setQueryData<ContentDetailT[]>(groupKey, reordered);
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(groupKey, ctx.previous);
    },
    // 后端 reorder 会重算 manifest_etag，所以 groups 缓存也要 invalidate。
    onSettled: () => {
      invalidate();
    },
  });
}
