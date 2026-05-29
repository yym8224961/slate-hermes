export const queryKeys = {
  me: ['me'] as const,
  groups: ['groups'] as const,
  group: (gid: string | undefined) => ['group', gid] as const,
  devices: ['devices'] as const,
  dynamic: {
    weatherCities: (query: string) => ['dynamic', 'weather-cities', query] as const,
  },
  contents: {
    group: (gid: string | undefined) => ['contents', gid] as const,
    detail: (contentId: string | undefined) => ['content', contentId] as const,
    image: (contentId: string, etag?: string | null) =>
      etag === undefined
        ? (['content-image', contentId] as const)
        : (['content-image', contentId, etag] as const),
    audio: (contentId: string, etag?: string | null) =>
      etag === undefined
        ? (['content-audio', contentId] as const)
        : (['content-audio', contentId, etag] as const),
  },
};
