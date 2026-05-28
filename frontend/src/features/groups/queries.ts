import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateGroupRequestT,
  GroupSummaryT,
  ReorderGroupsRequestT,
  UpdateGroupRequestT,
} from 'shared';
import { API_V1, api } from '@/lib/http';
import { queryKeys } from '@/lib/query-keys';

export function useGroups() {
  return useQuery({
    queryKey: queryKeys.groups,
    queryFn: async () => {
      const { data } = await api.get<GroupSummaryT[]>(`${API_V1}/groups`);
      return data;
    },
    staleTime: 10_000,
  });
}

export function useGroup(gid: string | undefined) {
  return useQuery({
    queryKey: queryKeys.group(gid),
    queryFn: async () => {
      const { data } = await api.get<GroupSummaryT>(`${API_V1}/groups/${gid}`);
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
      const { data } = await api.post<GroupSummaryT>(`${API_V1}/groups`, body);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.groups }),
  });
}

export function useUpdateGroup(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateGroupRequestT) => {
      const { data } = await api.patch<GroupSummaryT>(`${API_V1}/groups/${gid}`, body);
      return data;
    },
    onSuccess: (updated) => {
      qc.setQueryData(queryKeys.group(updated.id), updated);
      qc.setQueryData<GroupSummaryT[]>(queryKeys.groups, (groups) => {
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
      await api.put(`${API_V1}/groups/order`, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.groups }),
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (gid: string) => {
      await api.delete(`${API_V1}/groups/${gid}`);
    },
    onSuccess: (_data, gid) => {
      qc.removeQueries({ queryKey: queryKeys.group(gid) });
      qc.invalidateQueries({ queryKey: queryKeys.groups });
    },
  });
}
