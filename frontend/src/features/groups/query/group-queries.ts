import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateGroupRequestT,
  GroupSummaryT,
  ReorderGroupsRequestT,
  UpdateGroupRequestT,
} from 'shared';
import { API_PREFIX, api } from '@/lib/http';
import { deviceKeys } from '@/features/devices/query/keys';
import { groupKeys } from './keys';

export function useGroups() {
  return useQuery({
    queryKey: groupKeys.list,
    queryFn: async () => {
      const { data } = await api.get<GroupSummaryT[]>(`${API_PREFIX}/groups`);
      return data;
    },
    staleTime: 10_000,
  });
}

export function useGroup(gid: string | undefined) {
  return useQuery({
    queryKey: groupKeys.detail(gid),
    queryFn: async () => {
      const { data } = await api.get<GroupSummaryT>(`${API_PREFIX}/groups/${gid}`);
      return data;
    },
    enabled: !!gid,
    staleTime: 10_000,
  });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateGroupRequestT) => {
      const { data } = await api.post<GroupSummaryT>(`${API_PREFIX}/groups`, body);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: groupKeys.list }),
  });
}

export function useUpdateGroup(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateGroupRequestT) => {
      const { data } = await api.patch<GroupSummaryT>(`${API_PREFIX}/groups/${gid}`, body);
      return data;
    },
    onSuccess: (updated) => {
      qc.setQueryData(groupKeys.detail(updated.id), updated);
      qc.setQueryData<GroupSummaryT[]>(groupKeys.list, (groups) => {
        if (!groups) return groups;
        return groups.map((group) => (group.id === updated.id ? updated : group));
      });
    },
  });
}

export function useReorderGroups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ReorderGroupsRequestT) => {
      await api.put(`${API_PREFIX}/groups/order`, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: groupKeys.list }),
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (gid: string) => {
      await api.delete(`${API_PREFIX}/groups/${gid}`);
    },
    onSuccess: (_data, gid) => {
      qc.removeQueries({ queryKey: groupKeys.detail(gid) });
      qc.invalidateQueries({ queryKey: groupKeys.list });
      qc.invalidateQueries({ queryKey: deviceKeys.list });
    },
  });
}
