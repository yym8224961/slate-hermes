import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ContentDetailT,
  ContentMutationResponseT,
  CreateDynamicContentRequestT,
  DynamicConfigT,
  IngestResponseT,
  PatchContentRequestT,
  ReorderContentsRequestT,
} from 'shared';
import { api } from '@/lib/api';

const V1 = '/api/v1';

export function useGroupContents(gid: string | undefined) {
  return useQuery({
    queryKey: ['contents', gid],
    queryFn: async () => {
      const { data } = await api.get<ContentDetailT[]>(`${V1}/groups/${gid}/contents`);
      return data;
    },
    enabled: !!gid,
  });
}

export function useCreateImageContent(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (form: FormData) => {
      const { data } = await api.post<ContentMutationResponseT>(
        `${V1}/groups/${gid}/contents/image`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contents', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
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
      qc.invalidateQueries({ queryKey: ['contents', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
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
      qc.invalidateQueries({ queryKey: ['contents', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.removeQueries({ queryKey: ['dynamic-config', contentId] });
      qc.removeQueries({ queryKey: ['content-image', contentId] });
      qc.removeQueries({ queryKey: ['content-audio', contentId] });
    },
  });
}

export function useContentImage(contentId: string, etag: string) {
  return useQuery({
    queryKey: ['content-image', contentId, etag],
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

export function usePatchContent(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ contentId, body }: { contentId: string; body: PatchContentRequestT }) => {
      await api.patch(`${V1}/contents/${contentId}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contents', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useContentAudio(contentId: string, etag: string | null) {
  return useQuery({
    queryKey: ['content-audio', contentId, etag],
    queryFn: async () => {
      const { data } = await api.get<ArrayBuffer>(`${V1}/contents/${contentId}/audio`, {
        responseType: 'arraybuffer',
      });
      return data;
    },
    staleTime: Infinity,
    enabled: !!contentId && !!etag,
  });
}

export function useDeleteContentAudio(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contentId: string) => {
      await api.delete(`${V1}/contents/${contentId}/audio`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contents', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useReorderContents(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ReorderContentsRequestT) => {
      await api.put(`${V1}/groups/${gid}/contents/order`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contents', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useCreateDynamicContent(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateDynamicContentRequestT) => {
      const { data } = await api.post<ContentMutationResponseT>(
        `${V1}/groups/${gid}/contents/dynamic`,
        body,
        { headers: { 'Content-Type': 'application/json' } }
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contents', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
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
      qc.invalidateQueries({ queryKey: ['contents', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useUpdateContentAudio(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      contentId,
      frameName,
      audio,
    }: {
      contentId: string;
      frameName?: string | null;
      audio?: File | null;
    }) => {
      const form = new FormData();
      if (frameName !== undefined) form.append('frame_name', frameName ?? '');
      if (audio) form.append('audio', audio);
      const { data } = await api.patch<ContentMutationResponseT>(
        `${V1}/contents/${contentId}`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contents', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useDynamicConfig(contentId: string | undefined) {
  return useQuery({
    queryKey: ['dynamic-config', contentId],
    queryFn: async () => {
      const { data } = await api.get<{
        dynamic_type: string;
        config: DynamicConfigT;
        frame_name: string | null;
        device_status_bar_text: string;
      }>(`${V1}/contents/${contentId}/dynamic`);
      return data;
    },
    enabled: !!contentId,
    staleTime: 30_000,
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
      qc.invalidateQueries({ queryKey: ['contents', gid] });
      qc.removeQueries({ queryKey: ['content-image', contentId] });
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
      const body = contentId
        ? { config, frame_name: frameName }
        : { dynamic_type: config.type, config, frame_name: frameName };
      const { data } = await api.post<ArrayBuffer>(url, body, {
        responseType: 'arraybuffer',
      });
      return data;
    },
  });
}
