import { useQuery } from '@tanstack/react-query';
import type { ContentDetailT } from 'shared';
import { API_PREFIX, api } from '@/lib/http';
import { audioGenerationRefetchInterval } from './content-cache-helpers';
import { contentKeys } from './keys';

export function useGroupContents(gid: string | undefined) {
  return useQuery({
    queryKey: contentKeys.group(gid),
    queryFn: async () => {
      const { data } = await api.get<ContentDetailT[]>(`${API_PREFIX}/groups/${gid}/contents`);
      return data;
    },
    enabled: !!gid,
    refetchInterval: audioGenerationRefetchInterval,
  });
}

export function useContentDetail(contentId: string | undefined) {
  return useQuery({
    queryKey: contentKeys.detail(contentId),
    queryFn: async () => {
      const { data } = await api.get<ContentDetailT>(`${API_PREFIX}/contents/${contentId}`);
      return data;
    },
    enabled: !!contentId,
    refetchInterval: audioGenerationRefetchInterval,
  });
}
