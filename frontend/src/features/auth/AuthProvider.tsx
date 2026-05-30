// JWT 登录态管理。App 启动时如果 localStorage 有 token，自动 GET /users/current 回填 user
// （否则 Layout 等组件读 ctx.user 永远是 null，刷新后看不到登出菜单）。

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AUTH_TOKEN_STORAGE_KEY, setUnauthorizedHandler, tokenStorage } from '@/lib/auth-storage';
import { API_V1, api } from '@/lib/http';
import { meQueryKey, useMe } from '@/features/auth/queries';
import { closeSharedAudioContext } from '@/features/contents/components/audio/sharedAudioContext';
import { clearContentBitmapCache } from '@/features/contents/components/preview/useContentBitmap';
import type { LoginRequestT, LoginResponseT, RegisterRequestT, RegisterResponseT } from 'shared';
import { AuthContext } from './auth-context';
import { safeRedirectPath } from './redirect';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(tokenStorage.get());
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe(!!token);
  const user = token ? (me.data ?? null) : null;

  const clearLocalSession = useCallback(() => {
    setToken(null);
    qc.clear();
    clearContentBitmapCache();
    closeSharedAudioContext();
  }, [qc]);

  useEffect(() => {
    return setUnauthorizedHandler(() => {
      tokenStorage.clear({ resetUnauthorized: false });
      clearLocalSession();
      if (window.location.pathname !== '/login') navigate('/login', { replace: true });
    });
  }, [clearLocalSession, navigate]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== AUTH_TOKEN_STORAGE_KEY) return;
      if (!event.newValue) {
        clearLocalSession();
        if (window.location.pathname !== '/login') navigate('/login', { replace: true });
        return;
      }
      setToken(event.newValue);
      void qc.invalidateQueries({ queryKey: meQueryKey });
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [clearLocalSession, navigate, qc]);

  const login = useCallback(
    async (creds: LoginRequestT, redirectTo = '/') => {
      const { data } = await api.post<LoginResponseT>(`${API_V1}/sessions`, creds);
      tokenStorage.set(data.token);
      setToken(data.token);
      qc.setQueryData(meQueryKey, data.user);
      navigate(safeRedirectPath(redirectTo), { replace: true });
    },
    [navigate, qc]
  );

  const register = useCallback(
    async (creds: RegisterRequestT, redirectTo = '/') => {
      const { data } = await api.post<RegisterResponseT>(`${API_V1}/users`, creds);
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
    clearLocalSession();
    navigate('/login', { replace: true });
    if (existingToken) {
      api
        .delete(`${API_V1}/sessions/current`, {
          headers: { Authorization: `Bearer ${existingToken}` },
        })
        .catch(() => {});
    }
  }, [clearLocalSession, navigate]);

  return (
    <AuthContext.Provider value={{ token, user, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
