import { createContext } from 'react';
import type { LoginRequestT, RegisterRequestT } from 'shared';
import type { CurrentUser } from './queries';

export interface AuthState {
  token: string | null;
  user: CurrentUser | null;
  login: (creds: LoginRequestT, redirectTo?: string) => Promise<void>;
  register: (creds: RegisterRequestT, redirectTo?: string) => Promise<void>;
  logout: () => void;
}

export const AuthContext = createContext<AuthState | null>(null);
