import { appRoutes } from '@/app/routes';
import { setTokenStorageUnauthorizedStateResetter, tokenStorage } from './auth-storage';

let unauthorizedHandler: (() => void) | null = null;
let unauthorizedNotified = false;
let fallbackRedirectStarted = false;

export function resetUnauthorizedState(): void {
  unauthorizedNotified = false;
  fallbackRedirectStarted = false;
}

setTokenStorageUnauthorizedStateResetter(resetUnauthorizedState);

export function handleUnauthorizedFallback(): void {
  tokenStorage.clear({ resetUnauthorized: false });
  if (
    typeof window !== 'undefined' &&
    !fallbackRedirectStarted &&
    window.location.pathname !== appRoutes.login
  ) {
    fallbackRedirectStarted = true;
    window.location.href = appRoutes.login;
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
    console.warn('[auth] unauthorized listener added while another listener is active');
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
