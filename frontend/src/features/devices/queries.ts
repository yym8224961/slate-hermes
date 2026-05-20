import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ClaimDeviceRequestT,
  DeviceSummaryT,
  PatchDeviceRequestT,
  ReorderDevicesRequestT,
} from 'shared';
import { api } from '@/lib/api';

const V1 = '/api/v1';

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

export function useClaimByPairCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ClaimDeviceRequestT) => {
      const { data } = await api.post<DeviceSummaryT>(`${V1}/devices/claims`, body);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  });
}

export function useReorderDevices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ReorderDevicesRequestT) => {
      await api.put(`${V1}/devices/order`, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  });
}

export function useUnbindDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      await api.delete(`${V1}/devices/${deviceId}/binding`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  });
}

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
