import { appRoutes } from '@/app/routes';

export function safeRedirectPath(value: unknown): string {
  return isSafeRedirectPath(value) ? value : appRoutes.home;
}

export function redirectFromLocationState(state: unknown): string {
  const from = state && typeof state === 'object' ? (state as { from?: unknown }).from : null;
  if (!from || typeof from !== 'object') return appRoutes.home;
  const pathname = (from as { pathname?: unknown }).pathname;
  const search = (from as { search?: unknown }).search;
  const hash = (from as { hash?: unknown }).hash;
  if (!isSafeRedirectPath(pathname)) return appRoutes.home;
  return `${pathname}${typeof search === 'string' ? search : ''}${typeof hash === 'string' ? hash : ''}`;
}

function isSafeRedirectPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return false;
  return value !== appRoutes.login && value !== appRoutes.register;
}
