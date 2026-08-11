import { useQuery } from '@tanstack/react-query';
import type { HermesConnectionStatusT } from 'shared';
import { API_PREFIX, api } from '@/lib/http';

const hermesKeys = {
  status: ['hermes', 'status'] as const,
};

export function useHermesStatus() {
  return useQuery({
    queryKey: hermesKeys.status,
    queryFn: async () => {
      const { data } = await api.get<HermesConnectionStatusT>(`${API_PREFIX}/hermes/status`);
      return data;
    },
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}
