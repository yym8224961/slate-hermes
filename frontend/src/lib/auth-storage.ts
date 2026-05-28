const TOKEN_KEY = 'slate_jwt';

let unauthorizedHandler: (() => void) | null = null;

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function handleUnauthorizedFallback(): void {
  clearAuthToken();
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
}

export function notifyUnauthorized(): void {
  if (unauthorizedHandler) {
    unauthorizedHandler();
    return;
  }
  handleUnauthorizedFallback();
}

export function setUnauthorizedHandler(handler: () => void): () => void {
  if (unauthorizedHandler && unauthorizedHandler !== handler) {
    // StrictMode / HMR should clean up before installing again. Warn when a stale handler remains.
    console.warn('[api] setUnauthorizedHandler overwriting an existing handler');
  }
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

export const tokenStorage = {
  get: getAuthToken,
  set: (v: string) => localStorage.setItem(TOKEN_KEY, v),
  clear: clearAuthToken,
};
