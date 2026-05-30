import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ClaimDeviceRequestT,
  DeviceSummaryT,
  PatchDeviceRequestT,
  ReorderDevicesRequestT,
} from 'shared';
import { API_PREFIX, api } from '@/lib/http';
import { groupKeys } from '@/features/groups/query/keys';
import { deviceKeys } from './keys';

export function useDevices() {
  return useQuery({
    queryKey: deviceKeys.list,
    queryFn: async () => {
      const { data } = await api.get<DeviceSummaryT[]>(`${API_PREFIX}/devices`);
      return data;
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useClaimByPairCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ClaimDeviceRequestT) => {
      const { data } = await api.post<DeviceSummaryT>(`${API_PREFIX}/devices/claims`, body);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceKeys.list }),
  });
}

export function useReorderDevices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ReorderDevicesRequestT) => {
      await api.put(`${API_PREFIX}/devices/order`, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceKeys.list }),
  });
}

export function useUnbindDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      await api.delete(`${API_PREFIX}/devices/${deviceId}/binding`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceKeys.list }),
  });
}

export function usePatchDevice(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: PatchDeviceRequestT) => {
      await api.patch(`${API_PREFIX}/devices/${deviceId}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deviceKeys.list });
      qc.invalidateQueries({ queryKey: groupKeys.list });
    },
  });
}
