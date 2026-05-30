export const routePaths = {
  home: '/',
  login: '/login',
  register: '/register',
  deviceDetail: '/devices/:did',
  groupDetail: '/groups/:gid',
  contentNew: '/groups/:gid/contents/new',
  imageContentEdit: '/groups/:gid/contents/image/:contentId/edit',
  dynamicContentEdit: '/groups/:gid/contents/dynamic/:contentId/edit',
} as const;

export const appRoutes = {
  home: routePaths.home,
  login: routePaths.login,
  register: routePaths.register,
  device: (deviceId: string) => `/devices/${deviceId}`,
  group: (gid: string) => `/groups/${gid}`,
  newContent: (gid: string) => `/groups/${gid}/contents/new`,
  editImageContent: (gid: string, contentId: string) =>
    `/groups/${gid}/contents/image/${contentId}/edit`,
  editDynamicContent: (gid: string, contentId: string) =>
    `/groups/${gid}/contents/dynamic/${contentId}/edit`,
} as const;
