export const AUTH_TOKEN_STORAGE_KEY = 'slate_jwt';

interface ClearAuthTokenOptions {
  resetUnauthorized?: boolean;
}

let unauthorizedStateResetter: (() => void) | null = null;

export function setTokenStorageUnauthorizedStateResetter(reset: () => void): void {
  unauthorizedStateResetter = reset;
}

function getAuthToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
}

function clearAuthToken(): void {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

export const tokenStorage = {
  get: getAuthToken,
  set: (value: string) => {
    unauthorizedStateResetter?.();
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, value);
  },
  clear: (options?: ClearAuthTokenOptions) => {
    if (options?.resetUnauthorized !== false) unauthorizedStateResetter?.();
    clearAuthToken();
  },
};
