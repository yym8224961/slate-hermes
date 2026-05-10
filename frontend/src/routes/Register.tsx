// 注册：与 Login 同构，左侧 editorial 大字，右侧下划线表单。

import { useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Spinner } from '../components/Spinner';
import { IconBlock } from '../components/IconBlock';
import { useAuth } from '../lib/auth';
import { AxiosError } from 'axios';

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
      const data = (err as AxiosError<{ message?: string; error?: string }>)?.response?.data;
      setError(data?.message ?? data?.error ?? '注册失败，请稍后再试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr] bg-paper">
      <aside className="hidden lg:flex flex-col justify-between p-12 xl:p-16 border-r border-ink">
        <IconBlock size="xl" tone="brand" className="font-serif text-[28px] font-bold">
          墨
        </IconBlock>

        <div className="fade-up">
          <p className="font-sans text-[11px] text-stone uppercase tracking-[0.24em]">
            SLATE · 控制台
          </p>
          <div className="h-px bg-ink mt-3.5 mb-7" />
          <h1 className="font-serif text-[100px] xl:text-[132px] font-black leading-[0.92] tracking-[-0.04em] text-ink">
            注册
          </h1>
          <p className="font-serif text-[20px] text-stone mt-7 max-w-md leading-relaxed">
            创建账号，开始管理墨笺与内容。
          </p>
        </div>

        <span className="font-mono text-[11px] text-stone tracking-[0.06em]">
          400 × 300 · 1bpp · esp32-s3
        </span>
      </aside>

      <main className="flex items-start lg:items-center justify-center px-5 sm:px-8 pt-16 pb-32 lg:py-12">
        <form onSubmit={onSubmit} className="w-full max-w-sm fade-up fade-up-1">
          <div className="lg:hidden mb-10 text-center">
            <IconBlock size="xl" tone="brand" className="font-serif text-[28px] font-bold">
              墨
            </IconBlock>
            <h1 className="font-serif text-[36px] font-bold leading-none mt-3 tracking-tight">
              Slate
            </h1>
            <p className="font-sans text-[11px] text-stone mt-2 uppercase tracking-[0.2em]">
              案头那块墨水屏
            </p>
          </div>

          <h2 className="font-serif text-[40px] font-bold leading-tight tracking-tight">注册</h2>
          <p className="font-sans text-[13px] text-stone mt-1">邮箱 + 密码，密码至少 8 位</p>

          <div className="mt-8 space-y-7">
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
              error={confirmError ?? undefined}
            />
          </div>

          <div className="mt-8">
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

          <p className="mt-6 text-center font-sans text-[13px] text-stone">
            已有账号？{' '}
            <Link to="/login" className="text-ink border-b border-ink">
              去登录
            </Link>
          </p>
        </form>
      </main>
    </div>
  );
}
