import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

const V1 = '/api/v1';

export const meQueryKey = ['me'] as const;

export interface CurrentUser {
  id: string;
  email: string;
  username: string;
}

export async function fetchMe(): Promise<CurrentUser> {
  const { data } = await api.get<CurrentUser>(`${V1}/users/current`);
  return data;
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: fetchMe,
    enabled,
  });
}
