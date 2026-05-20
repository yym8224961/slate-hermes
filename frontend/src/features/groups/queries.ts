import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateGroupRequestT,
  GroupSummaryT,
  ReorderGroupsRequestT,
  UpdateGroupRequestT,
} from 'shared';
import { api } from '@/lib/api';

const V1 = '/api/v1';

export function useGroups() {
  return useQuery({
    queryKey: ['groups'],
    queryFn: async () => {
      const { data } = await api.get<GroupSummaryT[]>(`${V1}/groups`);
      return data;
    },
  });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateGroupRequestT) => {
      const { data } = await api.post<GroupSummaryT>(`${V1}/groups`, body);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}

export function useUpdateGroup(gid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateGroupRequestT) => {
      const { data } = await api.patch<GroupSummaryT>(`${V1}/groups/${gid}`, body);
      return data;
    },
    onSuccess: (updated) => {
      qc.setQueryData<GroupSummaryT[]>(['groups'], (groups) => {
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
      await api.put(`${V1}/groups/order`, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (gid: string) => {
      await api.delete(`${V1}/groups/${gid}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}
