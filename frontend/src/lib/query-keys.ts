export const queryKeys = {
  me: ['me'] as const,
  groups: ['groups'] as const,
  group: (gid: string | undefined) => ['group', gid] as const,
  devices: ['devices'] as const,
  contents: {
    group: (gid: string) => ['contents', gid] as const,
    maybeGroup: (gid: string | undefined) => ['contents', gid] as const,
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
