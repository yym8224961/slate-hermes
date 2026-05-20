import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

const V1 = '/api/v1';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await api.get<{ id: string; email: string; username: string }>(
        `${V1}/users/current`
      );
      return data;
    },
  });
}
