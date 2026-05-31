import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { appRoutes } from '@/app/routes';
import { AuthFormLayout } from '@/features/auth/components/AuthFormLayout';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { useAuthForm } from '@/features/auth/hooks/useAuthForm';
import { redirectFromLocationState } from '@/features/auth/lib/redirect';

type AuthPageMode = 'login' | 'register';

export function AuthPage({ mode }: { mode: AuthPageMode }) {
  return mode === 'login' ? <LoginAuthPage /> : <RegisterAuthPage />;
}

function LoginAuthPage() {
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
          <Link to={appRoutes.register} className="text-ink border-b border-ink">
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

function RegisterAuthPage() {
  const { token, register } = useAuth();
  const location = useLocation();
  const redirectTo = redirectFromLocationState(location.state);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RegisterField, string>>>({});
  const authForm = useAuthForm();

  if (token) return <Navigate to={redirectTo} replace />;

  async function onSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    authForm.setError(null);
    setFieldErrors({});

    const trimmedEmail = email.trim();
    const validationError = validateRegisterForm({
      email: trimmedEmail,
      username,
      password,
      confirm,
    });
    if (validationError) {
      setFieldErrors({ [validationError.field]: validationError.message });
      return;
    }

    await authForm.run(
      () => register({ email: trimmedEmail, username, password }, redirectTo),
      '注册失败，请稍后再试'
    );
  }

  return (
    <AuthFormLayout
      title="注册"
      subtitle="创建账号，开始管理墨笺与内容。"
      submitLabel="创建账号"
      loading={authForm.loading}
      error={authForm.error}
      onSubmit={onSubmit}
      footer={
        <p className="mt-7 text-center font-sans text-[13px] text-stone">
          已有账号？{' '}
          <Link to={appRoutes.login} className="text-ink border-b border-ink">
            去登录
          </Link>
        </p>
      }
    >
      <Input
        label="用户名"
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoFocus
        required
        autoComplete="username"
        placeholder="字母、数字、下划线，3-32 位"
        error={fieldErrors.username}
      />
      <Input
        label="邮箱"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoComplete="email"
        placeholder="you@example.com"
        error={fieldErrors.email}
      />
      <Input
        label="密码"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        minLength={8}
        autoComplete="new-password"
        placeholder="请输入密码"
        error={fieldErrors.password}
      />
      <Input
        label="确认密码"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
        minLength={8}
        autoComplete="new-password"
        placeholder="再次输入密码"
        error={fieldErrors.confirm}
      />
    </AuthFormLayout>
  );
}

type RegisterField = 'email' | 'username' | 'password' | 'confirm';

function validateRegisterForm({
  email,
  username,
  password,
  confirm,
}: {
  email: string;
  username: string;
  password: string;
  confirm: string;
}): { field: RegisterField; message: string } | null {
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    return { field: 'username', message: '用户名只能包含字母、数字、下划线，3-32 位' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { field: 'email', message: '请输入有效的邮箱地址' };
  }
  if (password.length < 8) {
    return { field: 'password', message: '密码至少 8 位' };
  }
  if (password !== confirm) {
    return { field: 'confirm', message: '两次输入的密码不一致' };
  }
  return null;
}
