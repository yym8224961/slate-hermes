import { useMutation, useQuery } from '@tanstack/react-query';
import type { ContentMutationResponseT, GenerateContentTtsRequestT } from 'shared';
import { API_PREFIX, api } from '@/lib/http';
import { useInvalidateContentDependencies } from './content-cache-helpers';
import { contentKeys } from './keys';

export function useContentAudio(contentId: string, etag: string | null, enabled = true) {
  return useQuery({
    queryKey: contentKeys.audio(contentId, etag),
    queryFn: async () => {
      const { data } = await api.get<ArrayBuffer>(`${API_PREFIX}/contents/${contentId}/audio`, {
        responseType: 'arraybuffer',
      });
      return data;
    },
    staleTime: Infinity,
    enabled: enabled && !!contentId && !!etag,
  });
}

export function useDeleteContentAudio(gid: string) {
  const invalidate = useInvalidateContentDependencies(gid);
  return useMutation({
    mutationFn: async (contentId: string) => {
      await api.delete(`${API_PREFIX}/contents/${contentId}/audio`);
    },
    onSuccess: (_data, contentId) => {
      invalidate(contentId);
    },
  });
}

export function useGenerateContentTts(gid: string) {
  const invalidate = useInvalidateContentDependencies(gid);
  return useMutation({
    mutationFn: async ({
      contentId,
      body,
    }: {
      contentId: string;
      body: GenerateContentTtsRequestT;
    }) => {
      const { data } = await api.post<ContentMutationResponseT>(
        `${API_PREFIX}/contents/${contentId}/audio/tts`,
        body
      );
      return data;
    },
    onSuccess: (data) => {
      invalidate(data.id);
    },
  });
}
