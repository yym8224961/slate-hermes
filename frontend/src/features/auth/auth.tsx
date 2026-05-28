/* eslint-disable react-refresh/only-export-components */
// JWT 登录态管理。App 启动时如果 localStorage 有 token，自动 GET /users/current 回填 user
// （否则 Layout 等组件读 ctx.user 永远是 null，刷新后看不到登出菜单）。

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { setUnauthorizedHandler, tokenStorage } from '@/lib/auth-storage';
import { api } from '@/lib/http';
import { meQueryKey, useMe, type CurrentUser } from '@/features/auth/queries';
import { clearContentBitmapCache } from '@/features/contents/components/preview/useContentBitmap';
import { safeRedirectPath } from '@/features/auth/redirect';
import type { LoginRequestT, LoginResponseT, RegisterRequestT, RegisterResponseT } from 'shared';

interface AuthState {
  token: string | null;
  user: CurrentUser | null;
  login: (creds: LoginRequestT, redirectTo?: string) => Promise<void>;
  register: (creds: RegisterRequestT, redirectTo?: string) => Promise<void>;
  logout: () => void;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(tokenStorage.get());
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe(!!token);
  const user = token ? (me.data ?? null) : null;

  useEffect(() => {
    return setUnauthorizedHandler(() => {
      tokenStorage.clear();
      setToken(null);
      qc.clear();
      clearContentBitmapCache();
      if (window.location.pathname !== '/login') navigate('/login', { replace: true });
    });
  }, [navigate, qc]);

  const login = useCallback(
    async (creds: LoginRequestT, redirectTo = '/') => {
      const { data } = await api.post<LoginResponseT>('/api/v1/sessions', creds);
      tokenStorage.set(data.token);
      setToken(data.token);
      qc.setQueryData(meQueryKey, data.user);
      navigate(safeRedirectPath(redirectTo), { replace: true });
    },
    [navigate, qc]
  );

  const register = useCallback(
    async (creds: RegisterRequestT, redirectTo = '/') => {
      const { data } = await api.post<RegisterResponseT>('/api/v1/users', creds);
      tokenStorage.set(data.token);
      setToken(data.token);
      qc.setQueryData(meQueryKey, data.user);
      navigate(safeRedirectPath(redirectTo), { replace: true });
    },
    [navigate, qc]
  );

  const logout = useCallback(() => {
    // 先把本地态清掉并跳登录页，再后台 best-effort 撤销 session：
    // 服务端 logout 现在还是占位 no-op，等失败也不影响用户体验。
    const existingToken = tokenStorage.get();
    tokenStorage.clear();
    setToken(null);
    qc.clear();
    clearContentBitmapCache();
    navigate('/login', { replace: true });
    if (existingToken) {
      api
        .delete('/api/v1/sessions/current', {
          headers: { Authorization: `Bearer ${existingToken}` },
        })
        .catch(() => {});
    }
  }, [navigate, qc]);

  return (
    <AuthCtx.Provider value={{ token, user, login, register, logout }}>{children}</AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
