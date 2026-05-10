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
  FrameSummaryT,
  PatchFrameRequestT,
  ReorderFramesRequestT,
  FrameMutationResponseT,
} from 'shared';

const V1 = '/api/v1';

// ── auth ────────────────────────────────────────────────────────────
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await api.get<{ id: string; email: string }>(`${V1}/me`);
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

// 解绑设备(把 owner 置 null + 轮换 pair_code)。设备本身的 device_secret 不变,
// 设备会通过 poll 拿到 owner=null + 新 pair_code,主动切回 splash 显示新码。
export function useUnbindDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      await api.delete(`${V1}/devices/${deviceId}/binding`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  });
}

// PATCH device:统一改 name / selected_group_id 的入口。
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

// ── frames ──────────────────────────────────────────────────────────
export function useGroupFrames(gid: string | undefined) {
  return useQuery({
    queryKey: ['frames', gid],
    queryFn: async () => {
      const { data } = await api.get<FrameSummaryT[]>(`${V1}/groups/${gid}/frames`);
      return data;
    },
    enabled: !!gid,
  });
}

// 创建新帧:multipart, image 必填,自动 append 到末尾。
export function useCreateFrame(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (form: FormData) => {
      const { data } = await api.post<FrameMutationResponseT>(`${V1}/groups/${gid}/frames`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['frames', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

// PATCH 单帧:multipart 改 image/audio,或 JSON 只改 caption。
export function useUpdateFrame(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ seq, form }: { seq: number; form: FormData }) => {
      const { data } = await api.patch<FrameMutationResponseT>(
        `${V1}/groups/${gid}/frames/${seq}`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['frames', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useDeleteFrame(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (seq: number) => {
      await api.delete(`${V1}/groups/${gid}/frames/${seq}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['frames', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

// 拉某帧的 1bpp binary。queryKey 带 etag,etag 变化(=内容变化)自动重拉。
export function useFrameImage(gid: string, seq: number, etag: string) {
  return useQuery({
    queryKey: ['frame-image', gid, seq, etag],
    queryFn: async () => {
      const { data } = await api.get<ArrayBuffer>(`${V1}/groups/${gid}/frames/${seq}/image`, {
        responseType: 'arraybuffer',
      });
      return data;
    },
    staleTime: Infinity, // etag 一致就别再请求
    enabled: !!gid && seq >= 0 && !!etag,
  });
}

// JSON-only PATCH(只改 caption)。multipart partial 走 useUpdateFrame。
export function usePatchFrame(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ seq, body }: { seq: number; body: PatchFrameRequestT }) => {
      await api.patch(`${V1}/groups/${gid}/frames/${seq}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['frames', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

// 拉某帧的 PCM binary。queryKey 带 etag,etag 变化(=内容变化)自动重拉。
export function useFrameAudio(gid: string, seq: number, etag: string | null) {
  return useQuery({
    queryKey: ['frame-audio', gid, seq, etag],
    queryFn: async () => {
      const { data } = await api.get<ArrayBuffer>(`${V1}/groups/${gid}/frames/${seq}/audio`, {
        responseType: 'arraybuffer',
      });
      return data;
    },
    staleTime: Infinity,
    enabled: !!gid && seq >= 0 && !!etag,
  });
}

export function useDeleteFrameAudio(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (seq: number) => {
      await api.delete(`${V1}/groups/${gid}/frames/${seq}/audio`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['frames', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useReorderFrames(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ReorderFramesRequestT) => {
      await api.put(`${V1}/groups/${gid}/frames/order`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['frames', gid] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}
