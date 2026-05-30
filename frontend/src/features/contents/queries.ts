import { useCallback } from 'react';
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
import { API_V1, api } from '@/lib/http';
import { groupKeys } from '@/features/groups/query-keys';
import { contentKeys } from './query-keys';
const AUDIO_GENERATING_REFETCH_INTERVAL_MS = 2500;

type AudioStatusRow = Pick<ContentDetailT, 'audio_status'>;
type AudioStatusQueryData = AudioStatusRow | AudioStatusRow[];

function audioGenerationRefetchInterval(query: { state: { data?: AudioStatusQueryData } }) {
  const data = query.state.data;
  const hasGeneratingAudio = Array.isArray(data)
    ? data.some(isGeneratingAudio)
    : isGeneratingAudio(data);
  return hasGeneratingAudio ? AUDIO_GENERATING_REFETCH_INTERVAL_MS : false;
}

function isGeneratingAudio(row: AudioStatusRow | undefined): boolean {
  return row?.audio_status === 'pending' || row?.audio_status === 'generating';
}

function invalidateGroupContent(
  qc: ReturnType<typeof useQueryClient>,
  gid: string,
  contentId?: string
) {
  void qc.invalidateQueries({ queryKey: contentKeys.group(gid) });
  void qc.invalidateQueries({ queryKey: groupKeys.list });
  void qc.invalidateQueries({ queryKey: groupKeys.detail(gid) });
  if (contentId) {
    void qc.invalidateQueries({ queryKey: contentKeys.detail(contentId) });
    qc.removeQueries({ queryKey: contentKeys.image(contentId) });
    qc.removeQueries({ queryKey: contentKeys.audio(contentId) });
  }
}

function useInvalidateGroupContent(gid: string) {
  const qc = useQueryClient();
  return useCallback((contentId?: string) => invalidateGroupContent(qc, gid, contentId), [gid, qc]);
}

export function useGroupContents(gid: string | undefined) {
  return useQuery({
    queryKey: contentKeys.group(gid),
    queryFn: async () => {
      const { data } = await api.get<ContentDetailT[]>(`${API_V1}/groups/${gid}/contents`);
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
      const { data } = await api.get<ContentDetailT>(`${API_V1}/contents/${contentId}`);
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
        `${API_V1}/groups/${gid}/contents`,
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
        `${API_V1}/contents/${contentId}`,
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
      await api.delete(`${API_V1}/contents/${contentId}`);
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
      const { data } = await api.get<ArrayBuffer>(`${API_V1}/contents/${contentId}/image`, {
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
      const { data } = await api.get<ArrayBuffer>(`${API_V1}/contents/${contentId}/audio`, {
        responseType: 'arraybuffer',
      });
      return data;
    },
    staleTime: Infinity,
    enabled: enabled && !!contentId && !!etag,
  });
}

export function useDeleteContentAudio(gid: string) {
  const invalidate = useInvalidateGroupContent(gid);
  return useMutation({
    mutationFn: async (contentId: string) => {
      await api.delete(`${API_V1}/contents/${contentId}/audio`);
    },
    onSuccess: (_data, contentId) => {
      invalidate(contentId);
    },
  });
}

export function useGenerateContentTts(gid: string) {
  const invalidate = useInvalidateGroupContent(gid);
  return useMutation({
    mutationFn: async ({
      contentId,
      body,
    }: {
      contentId: string;
      body: GenerateContentTtsRequestT;
    }) => {
      const { data } = await api.post<ContentMutationResponseT>(
        `${API_V1}/contents/${contentId}/audio/tts`,
        body
      );
      return data;
    },
    onSuccess: (data) => {
      invalidate(data.id);
    },
  });
}

export function useReorderContents(gid: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateGroupContent(gid);
  const groupKey = contentKeys.group(gid);
  return useMutation({
    mutationFn: async (body: ReorderContentsRequestT) => {
      await api.put(`${API_V1}/groups/${gid}/contents/order`, body);
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

export function useCreateDynamicContent(gid: string) {
  const invalidate = useInvalidateGroupContent(gid);
  return useMutation({
    mutationFn: async (body: CreateDynamicContentRequestT) => {
      const { data } = await api.post<ContentMutationResponseT>(
        `${API_V1}/groups/${gid}/contents`,
        body,
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
      return data;
    },
    onSuccess: (data) => {
      invalidate(data.id);
    },
  });
}

export function useUpdateDynamicContent(gid: string) {
  const invalidate = useInvalidateGroupContent(gid);
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
        `${API_V1}/contents/${contentId}`,
        body
      );
      return data;
    },
    onSuccess: (data) => {
      invalidate(data.id);
    },
  });
}

export function useRefreshDynamicContent(gid: string) {
  const invalidate = useInvalidateGroupContent(gid);
  return useMutation({
    mutationFn: async (contentId: string) => {
      const { data } = await api.post<IngestResponseT>(`${API_V1}/contents/${contentId}/refresh`);
      return data;
    },
    onSuccess: (_data, contentId) => {
      invalidate(contentId);
    },
  });
}

export function usePreviewDynamicContent(contentId: string | undefined) {
  return useMutation({
    mutationFn: async ({
      config,
      frameName,
      data: previewData,
      signal,
    }: {
      config: DynamicConfigT;
      frameName?: string | null;
      data?: Record<string, unknown>;
      signal?: AbortSignal;
    }) => {
      const url = contentId
        ? `${API_V1}/contents/${contentId}/preview`
        : `${API_V1}/contents/preview`;
      const body = { config, frame_name: frameName, data: previewData };
      const { data } = await api.post<ArrayBuffer>(url, body, {
        responseType: 'arraybuffer',
        signal,
      });
      return data;
    },
  });
}
