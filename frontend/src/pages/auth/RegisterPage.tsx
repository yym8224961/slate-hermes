// 注册：与 Login 同构，左侧 editorial 大字，右侧下划线表单。

import { useState } from 'react';
import { Navigate, Link, useLocation } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useAuth } from '@/features/auth/auth';
import { getApiErrorMessage } from '@/lib/api';
import { redirectFromLocationState } from './redirect';

export function RegisterPage() {
  const { token, register } = useAuth();
  const location = useLocation();
  const redirectTo = redirectFromLocationState(location.state);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (token) return <Navigate to={redirectTo} replace />;

  async function onSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    setError(null);
    setUsernameError(null);
    setPasswordError(null);
    setConfirmError(null);
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      setUsernameError('用户名只能包含字母、数字、下划线，3-32 位');
      return;
    }
    if (password.length < 8) {
      setPasswordError('密码至少 8 位');
      return;
    }
    if (password !== confirm) {
      setConfirmError('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    try {
      await register({ email, username, password }, redirectTo);
    } catch (err) {
      setError(getApiErrorMessage(err, '注册失败，请稍后再试'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="注册" subtitle="创建账号，开始管理墨笺与内容。">
      <form onSubmit={onSubmit}>
        <h2 className="font-serif text-[40px] font-bold leading-tight tracking-tight">注册</h2>

        <div className="mt-10 space-y-7">
          <Input
            label="用户名"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            required
            autoComplete="username"
            placeholder="字母、数字、下划线，3-32 位"
            error={usernameError ?? undefined}
          />
          <Input
            label="邮箱"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@example.com"
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
            error={passwordError ?? undefined}
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
            error={confirmError ?? undefined}
          />
        </div>

        <div className="mt-10">
          {error && <p className="mb-4 font-sans text-[13px] text-clay">{error}</p>}
          <Button
            type="submit"
            fullWidth
            size="lg"
            disabled={loading}
            iconRight={loading ? undefined : <ArrowRight size={16} />}
          >
            {loading ? <Spinner /> : '创建账号'}
          </Button>
        </div>

        <p className="mt-7 text-center font-sans text-[13px] text-stone">
          已有账号？{' '}
          <Link to="/login" className="text-ink border-b border-ink">
            去登录
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
