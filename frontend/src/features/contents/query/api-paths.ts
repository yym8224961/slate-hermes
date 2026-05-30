import { API_PREFIX } from '@/lib/http';

export const contentApiPaths = {
  data: (contentId: string) => `${API_PREFIX}/contents/${contentId}/data`,
} as const;

export function absoluteContentDataUrl(contentId: string): string {
  const path = contentApiPaths.data(contentId);
  if (typeof window === 'undefined') return path;
  return new URL(path, window.location.origin).toString();
}
