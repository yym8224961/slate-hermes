import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContentDetailT, ContentMutationResponseT, ReorderContentsRequestT } from 'shared';
import { API_PREFIX, api } from '@/lib/http';
import { audioGenerationRefetchInterval, useInvalidateGroupContent } from './cache';
import { contentKeys } from './keys';

export function useGroupContents(gid: string | undefined) {
  return useQuery({
    queryKey: contentKeys.group(gid),
    queryFn: async () => {
      const { data } = await api.get<ContentDetailT[]>(`${API_PREFIX}/groups/${gid}/contents`);
      return data;
    },
    enabled: !!gid,
    refetchInterval: audioGenerationRefetchInterval,
  });
}

export function useContentDetail(contentId: string | undefined) {
  return useQuery({
    queryKey: contentKeys.detail(contentId),
    queryFn: async () => {
      const { data } = await api.get<ContentDetailT>(`${API_PREFIX}/contents/${contentId}`);
      return data;
    },
    enabled: !!contentId,
    refetchInterval: audioGenerationRefetchInterval,
  });
}

export function useCreateImageContent(gid: string) {
  const invalidate = useInvalidateGroupContent(gid);
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
  const invalidate = useInvalidateGroupContent(gid);
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
  const invalidate = useInvalidateGroupContent(gid);
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

export function useContentImage(contentId: string, etag: string | null | undefined) {
  return useQuery({
    queryKey: contentKeys.image(contentId, etag),
    queryFn: async () => {
      const { data } = await api.get<ArrayBuffer>(`${API_PREFIX}/contents/${contentId}/image`, {
        responseType: 'arraybuffer',
      });
      return data;
    },
    staleTime: Infinity,
    enabled: !!contentId && !!etag,
  });
}

export function useReorderContents(gid: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateGroupContent(gid);
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
