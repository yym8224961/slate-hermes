// 登录：左侧 editorial 大字，右侧下划线表单。响应式：移动端单列居中。

import { useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Spinner } from '../components/Spinner';
import { IconBlock } from '../components/IconBlock';
import { useAuth } from '../lib/auth';
import { AxiosError } from 'axios';

export function Login() {
  const { token, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (token) return <Navigate to="/" replace />;

  async function onSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login({ email, password });
    } catch (err) {
      const data = (err as AxiosError<{ message?: string; error?: string }>)?.response?.data;
      setError(data?.message ?? data?.error ?? '登录失败，请检查邮箱和密码');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr] bg-paper">
      {/* 左侧：editorial 大字（lg+ 显示） */}
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
            登录
          </h1>
          <p className="font-serif text-[20px] text-stone mt-7 max-w-md leading-relaxed">
            登录后管理墨笺与内容。
          </p>
        </div>

        <span className="font-mono text-[11px] text-stone tracking-[0.06em]">
          400 × 300 · 1bpp · esp32-s3
        </span>
      </aside>

      {/* 右侧：表单 */}
      <main className="flex items-start lg:items-center justify-center px-5 sm:px-8 pt-16 pb-32 lg:py-12">
        <form onSubmit={onSubmit} className="w-full max-w-sm fade-up fade-up-1">
          {/* 移动端 logo */}
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

          <h2 className="font-serif text-[40px] font-bold leading-tight tracking-tight">登录</h2>
          <p className="font-sans text-[13px] text-stone mt-1">邮箱 + 密码</p>

          <div className="mt-10 space-y-7">
            <Input
              label="邮箱"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
              autoComplete="email"
              placeholder="admin@example.com"
            />
            <Input
              label="密码"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
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
      </main>
    </div>
  );
}
