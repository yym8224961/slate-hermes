export function redirectFromLocationState(state: unknown): string {
  const from = state && typeof state === 'object' ? (state as { from?: unknown }).from : null;
  if (!from || typeof from !== 'object') return '/';
  const pathname = (from as { pathname?: unknown }).pathname;
  const search = (from as { search?: unknown }).search;
  const hash = (from as { hash?: unknown }).hash;
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
    return '/';
  }
  if (pathname === '/login' || pathname === '/register') return '/';
  return `${pathname}${typeof search === 'string' ? search : ''}${typeof hash === 'string' ? hash : ''}`;
}
