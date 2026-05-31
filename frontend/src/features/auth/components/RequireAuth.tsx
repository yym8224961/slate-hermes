// 路由守卫:无 token 跳 /login。

import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { appRoutes } from '@/app/routes';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const location = useLocation();
  if (!token) {
    return <Navigate to={appRoutes.login} state={{ from: location }} replace />;
  }
  return <>{children}</>;
}
