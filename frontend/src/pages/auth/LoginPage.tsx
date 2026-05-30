// 登录：左侧 editorial 大字，右侧下划线表单。响应式：移动端单列居中。

import { useState } from 'react';
import { Navigate, Link, useLocation } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { redirectFromLocationState } from '@/features/auth/redirect';
import { useAuth } from '@/features/auth/useAuth';
import { useAuthForm } from '@/features/auth/useAuthForm';
import { AuthFormLayout } from './AuthFormLayout';

export function LoginPage() {
  const { token, login } = useAuth();
  const location = useLocation();
  const redirectTo = redirectFromLocationState(location.state);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const authForm = useAuthForm();

  if (token) return <Navigate to={redirectTo} replace />;

  async function onSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    await authForm.run(
      () => login({ identifier, password }, redirectTo),
      '登录失败，请检查账号和密码'
    );
  }

  return (
    <AuthFormLayout
      title="登录"
      subtitle="登录后管理墨笺与内容。"
      submitLabel="进入"
      loading={authForm.loading}
      error={authForm.error}
      onSubmit={onSubmit}
      footer={
        <p className="mt-7 text-center font-sans text-[13px] text-stone">
          还没有账号？{' '}
          <Link to="/register" className="text-ink border-b border-ink">
            立即注册
          </Link>
        </p>
      }
    >
      <Input
        label="账号或邮箱"
        type="text"
        value={identifier}
        onChange={(e) => setIdentifier(e.target.value)}
        autoFocus
        required
        autoComplete="username"
        placeholder="用户名或邮箱"
      />
      <Input
        label="密码"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        autoComplete="current-password"
        placeholder="请输入密码"
      />
    </AuthFormLayout>
  );
}
