import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ClaimDeviceRequestT,
  DeviceSummaryT,
  PatchDeviceRequestT,
  ReorderDevicesRequestT,
} from 'shared';
import { API_V1, api } from '@/lib/http';
import { queryKeys } from '@/lib/query-keys';

export function useDevices() {
  return useQuery({
    queryKey: queryKeys.devices,
    queryFn: async () => {
      const { data } = await api.get<DeviceSummaryT[]>(`${API_V1}/devices`);
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
      const { data } = await api.post<DeviceSummaryT>(`${API_V1}/devices/claims`, body);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.devices }),
  });
}

export function useReorderDevices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ReorderDevicesRequestT) => {
      await api.put(`${API_V1}/devices/order`, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.devices }),
  });
}

export function useUnbindDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      await api.delete(`${API_V1}/devices/${deviceId}/binding`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.devices }),
  });
}

export function usePatchDevice(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: PatchDeviceRequestT) => {
      await api.patch(`${API_V1}/devices/${deviceId}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.devices });
      qc.invalidateQueries({ queryKey: queryKeys.groups });
    },
  });
}
