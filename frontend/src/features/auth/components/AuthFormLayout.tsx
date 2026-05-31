import type { FormEvent, ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { AuthLayout } from '@/features/auth/components/AuthLayout';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';

export function AuthFormLayout({
  title,
  subtitle,
  submitLabel,
  loading,
  error,
  footer,
  children,
  onSubmit,
}: {
  title: string;
  subtitle: string;
  submitLabel: string;
  loading: boolean;
  error?: string | null;
  footer: ReactNode;
  children: ReactNode;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
}) {
  return (
    <AuthLayout title={title} subtitle={subtitle}>
      <form onSubmit={onSubmit}>
        <h2 className="font-serif text-[40px] font-bold leading-tight tracking-tight">{title}</h2>

        <div className="mt-10 space-y-7">{children}</div>

        <div className="mt-10">
          {error && <p className="mb-4 font-sans text-[13px] text-clay">{error}</p>}
          <Button
            type="submit"
            fullWidth
            size="lg"
            disabled={loading}
            iconRight={loading ? undefined : <ArrowRight size={16} />}
          >
            {loading ? <Spinner /> : submitLabel}
          </Button>
        </div>

        {footer}
      </form>
    </AuthLayout>
  );
}
