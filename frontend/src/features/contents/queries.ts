import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ContentDetailT,
  ContentMutationResponseT,
  CreateDynamicContentRequestT,
  DynamicConfigT,
  GenerateContentTtsRequestT,
  IngestResponseT,
  ReorderContentsRequestT,
} from 'shared';
import { api } from '@/lib/api';

const V1 = '/api/v1';

const contentKeys = {
  group: (gid: string) => ['contents', gid] as const,
  image: (contentId: string, etag?: string) =>
    etag === undefined
      ? (['content-image', contentId] as const)
      : (['content-image', contentId, etag] as const),
  audio: (contentId: string, etag?: string | null) =>
    etag === undefined
      ? (['content-audio', contentId] as const)
      : (['content-audio', contentId, etag] as const),
};

function invalidateGroupContent(
  qc: ReturnType<typeof useQueryClient>,
  gid: string,
  contentId?: string
) {
  void qc.invalidateQueries({ queryKey: contentKeys.group(gid) });
  void qc.invalidateQueries({ queryKey: ['groups'] });
  if (contentId) {
    qc.removeQueries({ queryKey: contentKeys.image(contentId) });
    qc.removeQueries({ queryKey: contentKeys.audio(contentId) });
  }
}

export function useGroupContents(gid: string | undefined) {
  return useQuery({
    queryKey: gid ? contentKeys.group(gid) : ['contents', gid],
    queryFn: async () => {
      const { data } = await api.get<ContentDetailT[]>(`${V1}/groups/${gid}/contents`);
      return data;
    },
    enabled: !!gid,
    refetchInterval: (query) => {
      const rows = query.state.data;
      return rows?.some(
        (row) => row.audio_status === 'pending' || row.audio_status === 'generating'
      )
        ? 2500
        : false;
    },
  });
}

export function useCreateImageContent(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (form: FormData) => {
      const { data } = await api.post<ContentMutationResponseT>(
        `${V1}/groups/${gid}/contents`,
        form,
        {
          headers: { 'Content-Type': 'multipart/form-data' },
        }
      );
      return data;
    },
    onSuccess: () => {
      invalidateGroupContent(qc, gid);
    },
  });
}

export function useUpdateImageContent(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ contentId, form }: { contentId: string; form: FormData }) => {
      const { data } = await api.patch<ContentMutationResponseT>(
        `${V1}/contents/${contentId}`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      return data;
    },
    onSuccess: () => {
      invalidateGroupContent(qc, gid);
    },
  });
}

export function useDeleteContent(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contentId: string) => {
      await api.delete(`${V1}/contents/${contentId}`);
      return contentId;
    },
    onSuccess: (_data, contentId) => {
      invalidateGroupContent(qc, gid, contentId);
    },
  });
}

export function useContentImage(contentId: string, etag: string) {
  return useQuery({
    queryKey: contentKeys.image(contentId, etag),
    queryFn: async () => {
      const { data } = await api.get<ArrayBuffer>(`${V1}/contents/${contentId}/image`, {
        responseType: 'arraybuffer',
      });
      return data;
    },
    staleTime: Infinity,
    enabled: !!contentId && !!etag,
  });
}

export function useContentAudio(contentId: string, etag: string | null, enabled = true) {
  return useQuery({
    queryKey: contentKeys.audio(contentId, etag),
    queryFn: async () => {
      const { data } = await api.get<ArrayBuffer>(`${V1}/contents/${contentId}/audio`, {
        responseType: 'arraybuffer',
      });
      return data;
    },
    staleTime: Infinity,
    enabled: enabled && !!contentId && !!etag,
  });
}

export function useDeleteContentAudio(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contentId: string) => {
      await api.delete(`${V1}/contents/${contentId}/audio`);
    },
    onSuccess: () => {
      invalidateGroupContent(qc, gid);
    },
  });
}

export function useGenerateContentTts(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      contentId,
      body,
    }: {
      contentId: string;
      body: GenerateContentTtsRequestT;
    }) => {
      const { data } = await api.post<ContentMutationResponseT>(
        `${V1}/contents/${contentId}/audio/tts`,
        body
      );
      return data;
    },
    onSuccess: () => {
      invalidateGroupContent(qc, gid);
    },
  });
}

export function useReorderContents(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ReorderContentsRequestT) => {
      await api.put(`${V1}/groups/${gid}/contents/order`, body);
    },
    // 乐观更新 seq：避免拖拽落点到 refetch 完成之间 ContentCard 显示旧序号。
    onMutate: async ({ order }) => {
      await qc.cancelQueries({ queryKey: contentKeys.group(gid) });
      const previous = qc.getQueryData<ContentDetailT[]>(contentKeys.group(gid));
      if (previous) {
        const byId = new Map(previous.map((c) => [c.id, c]));
        const reordered: ContentDetailT[] = order
          .map((id, idx) => {
            const item = byId.get(id);
            return item ? { ...item, seq: idx } : undefined;
          })
          .filter((c): c is ContentDetailT => c !== undefined);
        qc.setQueryData<ContentDetailT[]>(contentKeys.group(gid), reordered);
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(contentKeys.group(gid), ctx.previous);
    },
    // 后端 reorder 会重算 manifest_etag，所以 groups 缓存也要 invalidate。
    onSettled: () => {
      invalidateGroupContent(qc, gid);
    },
  });
}

export function useCreateDynamicContent(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateDynamicContentRequestT) => {
      const { data } = await api.post<ContentMutationResponseT>(
        `${V1}/groups/${gid}/contents`,
        body,
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
      return data;
    },
    onSuccess: () => {
      invalidateGroupContent(qc, gid);
    },
  });
}

export function useUpdateDynamicContent(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      contentId,
      frameName,
      config,
    }: {
      contentId: string;
      frameName?: string | null;
      config?: DynamicConfigT;
    }) => {
      const body: { frame_name?: string | null; config?: DynamicConfigT } = {};
      if (frameName !== undefined) body.frame_name = frameName;
      if (config !== undefined) body.config = config;
      const { data } = await api.patch<ContentMutationResponseT>(
        `${V1}/contents/${contentId}`,
        body
      );
      return data;
    },
    onSuccess: () => {
      invalidateGroupContent(qc, gid);
    },
  });
}

export function useRefreshDynamicContent(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contentId: string) => {
      const { data } = await api.post<IngestResponseT>(`${V1}/contents/${contentId}/refresh`);
      return data;
    },
    onSuccess: (_data, contentId) => {
      invalidateGroupContent(qc, gid, contentId);
    },
  });
}

export function usePreviewDynamicContent(contentId: string | undefined) {
  return useMutation({
    mutationFn: async ({
      config,
      frameName,
    }: {
      config: DynamicConfigT;
      frameName?: string | null;
    }) => {
      const url = contentId ? `${V1}/contents/${contentId}/preview` : `${V1}/contents/preview`;
      const body = { config, frame_name: frameName };
      const { data } = await api.post<ArrayBuffer>(url, body, {
        responseType: 'arraybuffer',
      });
      return data;
    },
  });
}
