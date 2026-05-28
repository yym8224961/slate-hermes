import { useQuery } from '@tanstack/react-query';
import { API_V1, api } from '@/lib/http';
import { queryKeys } from '@/lib/query-keys';

export const meQueryKey = queryKeys.me;

export interface CurrentUser {
  id: string;
  email: string;
  username: string;
}

export async function fetchMe(): Promise<CurrentUser> {
  const { data } = await api.get<CurrentUser>(`${API_V1}/users/current`);
  return data;
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: fetchMe,
    enabled,
  });
}
