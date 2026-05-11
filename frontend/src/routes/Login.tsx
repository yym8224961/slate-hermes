// 登录：左侧 editorial 大字，右侧下划线表单。响应式：移动端单列居中。

import { useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Spinner } from '../components/Spinner';
import { AuthLayout } from '../components/AuthLayout';
import { useAuth } from '../lib/auth';
import { getApiErrorMessage } from '../lib/api-error';

export function Login() {
  const { token, login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (token) return <Navigate to="/" replace />;

  async function onSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login({ identifier, password });
    } catch (err) {
      setError(getApiErrorMessage(err, '登录失败，请检查账号和密码'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="登录" subtitle="登录后管理墨笺与内容。">
      <form onSubmit={onSubmit}>
        <h2 className="font-serif text-[40px] font-bold leading-tight tracking-tight">登录</h2>

        <div className="mt-10 space-y-7">
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
            error={error ?? undefined}
          />
        </div>

        <div className="mt-10">
          <Button
            type="submit"
            fullWidth
            size="lg"
            disabled={loading}
            iconRight={loading ? undefined : <ArrowRight size={16} />}
          >
            {loading ? <Spinner /> : '进入'}
          </Button>
        </div>

        <p className="mt-7 text-center font-sans text-[13px] text-stone">
          还没有账号？{' '}
          <Link to="/register" className="text-ink border-b border-ink">
            立即注册
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
