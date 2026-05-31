import { appRoutes } from '@/app/routes';

export function safeRedirectPath(value: unknown): string {
  return isSafeRedirectPath(value) ? value : appRoutes.home;
}

export function redirectFromLocationState(state: unknown): string {
  if (!isRecord(state)) return appRoutes.home;
  const { from } = state;
  if (!isRecord(from)) return appRoutes.home;
  const { pathname, search, hash } = from;
  if (!isSafeRedirectPath(pathname)) return appRoutes.home;
  return `${pathname}${typeof search === 'string' ? search : ''}${typeof hash === 'string' ? hash : ''}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isSafeRedirectPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return false;
  return value !== appRoutes.login && value !== appRoutes.register;
}
