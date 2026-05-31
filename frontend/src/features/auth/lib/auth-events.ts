import { appRoutes } from '@/app/routes';
import { tokenStorage } from './auth-storage';

let unauthorizedHandler: (() => void) | null = null;
let unauthorizedNotified = false;
let unauthorizedPending = false;

export function resetUnauthorizedState(): void {
  unauthorizedNotified = false;
  unauthorizedPending = false;
}

function handleUnauthorizedFallback(): void {
  tokenStorage.clear();
  if (typeof window === 'undefined' || window.location.pathname === appRoutes.login) return;
  window.location.href = appRoutes.login;
}

function runUnauthorizedHandler(): void {
  if (!unauthorizedPending) return;
  unauthorizedPending = false;
  if (unauthorizedHandler) {
    unauthorizedHandler();
    return;
  }
  handleUnauthorizedFallback();
}

export function notifyUnauthorized(): void {
  if (unauthorizedNotified) return;
  unauthorizedNotified = true;
  unauthorizedPending = true;
  globalThis.setTimeout(runUnauthorizedHandler, 0);
}

export function setUnauthorizedHandler(handler: () => void): () => void {
  if (unauthorizedHandler && unauthorizedHandler !== handler) {
    console.warn('[auth] unauthorized listener added while another listener is active');
  }
  unauthorizedHandler = handler;
  if (unauthorizedPending) runUnauthorizedHandler();
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
