export const groupKeys = {
  list: ['groups'] as const,
  detail: (gid: string | undefined) => ['group', gid] as const,
};
