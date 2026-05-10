// 注册:与 Login 同构的左右分栏布局,提交成功后服务端直接发 JWT,免二次登录。

import { useState, type FormEvent } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Spinner } from '../components/Spinner';
import { IconBlock } from '../components/IconBlock';
import { useAuth } from '../lib/auth';

export function Register() {
  const { token, register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (token) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    try {
      await register({ email, password });
    } catch (err) {
      const env = (err as { response?: { data?: { message?: string; error?: string } } })?.response
        ?.data;
      setError(env?.message ?? env?.error ?? '注册失败,请稍后再试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr] bg-paper">
      <aside className="hidden lg:flex flex-col justify-between p-12 xl:p-16 bg-cream relative overflow-hidden">
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
            注册
          </h1>
          <p className="font-kai text-[18px] xl:text-[20px] text-stone mt-6 max-w-md leading-loose">
            建一个账号,开始管理墨笺与内容。
          </p>
        </div>

        <div className="relative font-mono text-[11px] text-stone-light tracking-wide">
          400 × 300 · 1bpp · esp32-s3
        </div>
      </aside>

      <main className="flex items-start lg:items-center justify-center px-5 sm:px-8 pt-16 pb-32 lg:py-12">
        <form onSubmit={onSubmit} className="w-full max-w-sm fade-up fade-up-1">
          <div className="lg:hidden mb-10 text-center">
            <IconBlock size="xl" tone="brand" className="font-kai text-[28px]">
              墨
            </IconBlock>
            <h1 className="font-kai text-[36px] leading-none mt-3">Slate</h1>
            <p className="font-kai text-[14px] text-stone mt-2">案头那块墨水屏</p>
          </div>

          <h2 className="font-kai text-[32px] leading-tight">注册</h2>
          <p className="font-sans text-[14px] text-stone mt-1">邮箱 + 密码,密码至少 8 位。</p>

          <div className="mt-8 space-y-5">
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
            />
            <Input
              label="确认密码"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
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
              {loading ? <Spinner /> : '创建账号'}
            </Button>
          </div>

          <p className="mt-6 text-center font-sans text-[13px] text-stone">
            已有账号?{' '}
            <Link to="/login" className="text-ink underline-offset-4 hover:underline">
              去登录
            </Link>
          </p>
        </form>
      </main>
    </div>
  );
}
