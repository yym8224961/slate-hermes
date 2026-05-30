import { useContext } from 'react';
import { AuthContext, type AuthState } from '@/features/auth/model/auth-context';

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
