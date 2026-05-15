// TanStack Query 钩子 — 把 API 端点封装成 useXxx hooks。
// 所有 path 走 /api/v1/* 单一前缀。

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type {
  DeviceSummaryT,
  GroupSummaryT,
  CreateGroupRequestT,
  UpdateGroupRequestT,
  ReorderGroupsRequestT,
  PatchDeviceRequestT,
  ClaimByPairCodeRequestT,
  ReorderDevicesRequestT,
  ContentDetailT,
  PatchContentRequestT,
  ReorderContentsRequestT,
  ContentMutationResponseT,
  CreateDynamicContentRequestT,
  DynamicConfigT,
  IngestResponseT,
} from 'shared';

const V1 = '/api/v1';

// ── auth ────────────────────────────────────────────────────────────
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await api.get<{ id: string; email: string; username: string }>(`${V1}/me`);
      return data;
    },
  });
}

// ── devices ─────────────────────────────────────────────────────────
export function useDevices() {
  return useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const { data } = await api.get<DeviceSummaryT[]>(`${V1}/devices`);
      return data;
    },
    refetchInterval: 30_000,
  });
}

// 按设备屏上显示的 6 位配对码绑定设备。设备必须已联网注册(屏上能看到码)。
export function useClaimByPairCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ClaimByPairCodeRequestT) => {
      const { data } = await api.post<DeviceSummaryT>(`${V1}/devices/claim-by-pair-code`, body);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  });
}

// 设备拖拽排序。order = 新 device_id 顺序。
export function useReorderDevices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ReorderDevicesRequestT) => {
      await api.put(`${V1}/devices/order`, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  });
}

// 解绑设备（把 owner 置 null + 轮换 pair_code）。设备本身的 device_secret 不变，
// 设备会通过 poll 拿到 owner=null + 新 pair_code，主动切回 splash 显示新码。
export function useUnbindDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      await api.delete(`${V1}/devices/${deviceId}/binding`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  });
}

// PATCH device：统一改 name / selected_group_id 的入口。
export function usePatchDevice(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: PatchDeviceRequestT) => {
      await api.patch(`${V1}/devices/${deviceId}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

// ── groups ──────────────────────────────────────────────────────────
export function useGroups() {
  return useQuery({
    queryKey: ['groups'],
    queryFn: async () => {
      const { data } = await api.get<GroupSummaryT[]>(`${V1}/groups`);
      return data;
    },
  });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateGroupRequestT) => {
      const { data } = await api.post<GroupSummaryT>(`${V1}/groups`, body);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}

export function useUpdateGroup(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateGroupRequestT) => {
      await api.patch(`${V1}/groups/${gid}`, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}

export function useReorderGroups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ReorderGroupsRequestT) => {
      await api.put(`${V1}/groups/order`, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (gid: string) => {
      await api.delete(`${V1}/groups/${gid}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}

// ── contents ────────────────────────────────────────────────────────
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

// ── dynamic contents ────────────────────────────────────────────────

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
      title,
      config,
    }: {
      contentId: string;
      title?: string | null;
      config?: DynamicConfigT;
    }) => {
      const body: { title?: string | null; config?: DynamicConfigT } = {};
      if (title !== undefined) body.title = title;
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
      title,
      audio,
    }: {
      contentId: string;
      title?: string | null;
      audio?: File | null;
    }) => {
      const form = new FormData();
      if (title !== undefined) form.append('title', title ?? '');
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
        title: string | null;
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contents', gid] });
    },
  });
}

/**
 * 预览动态内容配置（不保存）。返回 1bpp 帧缓冲（ArrayBuffer，15000 字节）。
 * 供动态内容编辑器实时预览使用。
 */
export function usePreviewDynamicContent(contentId: string | undefined) {
  return useMutation({
    mutationFn: async ({ config, title }: { config: DynamicConfigT; title?: string | null }) => {
      const url = contentId ? `${V1}/contents/${contentId}/preview` : `${V1}/contents/preview`;
      const body = contentId ? { config, title } : { dynamic_type: config.type, config, title };
      const { data } = await api.post<ArrayBuffer>(url, body, { responseType: 'arraybuffer' });
      return data;
    },
  });
}
