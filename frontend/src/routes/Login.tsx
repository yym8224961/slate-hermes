// 登录:左侧大色块 + 楷书欢迎语,右侧表单。响应式:移动端单卡片居中。

import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Spinner } from '../components/Spinner';
import { IconBlock } from '../components/IconBlock';
import { useAuth } from '../lib/auth';

export function Login() {
  const { token, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (token) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login({ email, password });
    } catch (err) {
      const env = (err as { response?: { data?: { message?: string; error?: string } } })?.response
        ?.data;
      setError(env?.message ?? env?.error ?? '登录失败,请检查邮箱和密码');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr] bg-paper">
      {/* 左侧:暖色块 + 欢迎语(只在 lg+ 屏显示) */}
      <aside className="hidden lg:flex flex-col justify-between p-12 xl:p-16 bg-cream relative overflow-hidden">
        {/* 装饰圆点 */}
        <div className="absolute -top-12 -right-12 w-72 h-72 rounded-full bg-clay/12 blur-2xl" />
        <div className="absolute bottom-20 -left-16 w-56 h-56 rounded-full bg-saffron/30 blur-3xl" />

        <div className="relative">
          <IconBlock size="xl" tone="brand" className="font-kai text-[28px]">
            墨
          </IconBlock>
        </div>

        <div className="relative fade-up">
          <p className="font-kai text-[20px] text-stone mb-4">Slate · 控制台</p>
          <h1 className="font-kai text-[64px] xl:text-[80px] leading-[1.1] text-ink tracking-tight">
            登录
          </h1>
          <p className="font-kai text-[18px] xl:text-[20px] text-stone mt-6 max-w-md leading-loose">
            登录后管理写字板与内容。
          </p>
        </div>

        <div className="relative font-mono text-[11px] text-stone-light tracking-wide">
          400 × 300 · 1bpp · esp32-s3
        </div>
      </aside>

      {/* 右侧:表单。
          移动端用 pb-32 给软键盘弹出后的"进入"按钮留滚动空间;
          desktop 居中,所以 lg:py-12 lg:pb-12 重置回来。 */}
      <main className="flex items-start lg:items-center justify-center px-5 sm:px-8 pt-16 pb-32 lg:py-12">
        <form onSubmit={onSubmit} className="w-full max-w-sm fade-up fade-up-1">
          {/* 移动端 logo */}
          <div className="lg:hidden mb-10 text-center">
            <IconBlock size="xl" tone="brand" className="font-kai text-[28px]">
              墨
            </IconBlock>
            <h1 className="font-kai text-[36px] leading-none mt-3">Slate</h1>
            <p className="font-kai text-[14px] text-stone mt-2">案头那块墨水屏</p>
          </div>

          <h2 className="font-kai text-[32px] leading-tight">登录</h2>
          <p className="font-sans text-[14px] text-stone mt-1">邮箱 + 密码。</p>

          <div className="mt-8 space-y-5">
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

          <div className="mt-8">
            <Button
              type="submit"
              fullWidth
              size="lg"
              disabled={loading}
              iconRight={<ArrowRight size={16} />}
            >
              {loading ? <Spinner /> : '进入'}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
