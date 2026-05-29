const TOKEN_KEY = 'slate_jwt';

let unauthorizedHandler: (() => void) | null = null;
let unauthorizedNotified = false;
let fallbackRedirectStarted = false;

interface ClearAuthTokenOptions {
  resetUnauthorized?: boolean;
}

function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function resetUnauthorizedState(): void {
  unauthorizedNotified = false;
  fallbackRedirectStarted = false;
}

export function handleUnauthorizedFallback(): void {
  clearAuthToken();
  if (
    typeof window !== 'undefined' &&
    !fallbackRedirectStarted &&
    window.location.pathname !== '/login'
  ) {
    fallbackRedirectStarted = true;
    window.location.href = '/login';
  }
}

export function notifyUnauthorized(): void {
  if (unauthorizedNotified) return;
  unauthorizedNotified = true;
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

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unauthorizedHandler = null;
    resetUnauthorizedState();
  });
}

export const tokenStorage = {
  get: getAuthToken,
  set: (v: string) => {
    resetUnauthorizedState();
    localStorage.setItem(TOKEN_KEY, v);
  },
  clear: (options?: ClearAuthTokenOptions) => {
    if (options?.resetUnauthorized !== false) resetUnauthorizedState();
    clearAuthToken();
  },
};
