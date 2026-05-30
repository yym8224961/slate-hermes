import { useQuery } from '@tanstack/react-query';
import { API_PREFIX, api } from '@/lib/http';

export const meQueryKey = ['me'] as const;

export interface CurrentUser {
  id: string;
  email: string;
  username: string;
}

export async function fetchMe(): Promise<CurrentUser> {
  const { data } = await api.get<CurrentUser>(`${API_PREFIX}/users/current`);
  return data;
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: fetchMe,
    enabled,
  });
}
