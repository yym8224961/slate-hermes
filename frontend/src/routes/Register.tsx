// 注册：与 Login 同构，左侧 editorial 大字，右侧下划线表单。

import { useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Spinner } from '../components/Spinner';
import { AuthLayout } from '../components/AuthLayout';
import { useAuth } from '../lib/auth';
import { getApiErrorMessage } from '../lib/api-error';

export function Register() {
  const { token, register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (token) return <Navigate to="/" replace />;

  async function onSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    setError(null);
    setPasswordError(null);
    setConfirmError(null);
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
      await register({ email, password });
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
            label="邮箱"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
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
