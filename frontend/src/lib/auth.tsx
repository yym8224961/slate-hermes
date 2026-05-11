/* eslint-disable react-refresh/only-export-components */
// JWT 登录态管理。app 启动时如果 localStorage 有 token,自动 GET /me 回填 user
// (否则 Layout 等组件读 ctx.user 永远是 null,刷新后看不到登出菜单)。

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, tokenStorage } from './api';
import type { LoginRequestT, LoginResponseT, RegisterRequestT, RegisterResponseT } from 'shared';

interface AuthState {
  token: string | null;
  user: { id: string; email: string; username: string } | null;
  login: (creds: LoginRequestT) => Promise<void>;
  register: (creds: RegisterRequestT) => Promise<void>;
  logout: () => void;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(tokenStorage.get());
  const [user, setUser] = useState<AuthState['user']>(null);
  const navigate = useNavigate();

  // 启动 / token 变化时自动拉 user。401 走 axios 拦截器跳登录页。
  useEffect(() => {
    if (!token) {
      setUser(null);
      return;
    }
    let cancelled = false;
    api
      .get<{ id: string; email: string; username: string }>('/api/v1/me')
      .then(({ data }) => {
        if (!cancelled) setUser(data);
      })
      .catch(() => {
        // 401 已由 axios 拦截器处理(清 token + 跳 /login)
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const login = useCallback(
    async (creds: LoginRequestT) => {
      const { data } = await api.post<LoginResponseT>('/api/v1/sessions', creds);
      tokenStorage.set(data.token);
      setToken(data.token);
      setUser(data.user);
      navigate('/', { replace: true });
    },
    [navigate]
  );

  const register = useCallback(
    async (creds: RegisterRequestT) => {
      const { data } = await api.post<RegisterResponseT>('/api/v1/users', creds);
      tokenStorage.set(data.token);
      setToken(data.token);
      setUser(data.user);
      navigate('/', { replace: true });
    },
    [navigate]
  );

  const logout = useCallback(() => {
    tokenStorage.clear();
    setToken(null);
    setUser(null);
    navigate('/login', { replace: true });
  }, [navigate]);

  return (
    <AuthCtx.Provider value={{ token, user, login, register, logout }}>{children}</AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
