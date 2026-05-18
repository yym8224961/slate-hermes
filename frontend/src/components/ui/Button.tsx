// Mono Press 按钮：0px 圆角、uppercase 字母间距、实心墨 / 描边 / 危险三变体。

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'outline' | 'soft' | 'link' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth,
  iconLeft,
  iconRight,
  className,
  children,
  ...rest
}: ButtonProps) {
  const sizeCls =
    size === 'sm'
      ? 'h-9 px-3.5 text-[11px] gap-1.5'
      : size === 'lg'
        ? 'h-14 px-6 text-[13px] gap-2.5'
        : 'h-10 px-4 text-[12px] gap-2';

  const base =
    'inline-flex items-center justify-center font-sans font-medium ' +
    'uppercase tracking-[0.2em] ' +
    'transition-colors duration-150 select-none ' +
    'disabled:cursor-not-allowed disabled:opacity-40';

  const tone =
    variant === 'primary'
      ? 'bg-ink text-paper border border-ink hover:bg-stone active:bg-stone'
      : variant === 'outline'
        ? 'bg-transparent text-ink border border-ink hover:bg-cream-deep active:bg-cream-deep'
        : variant === 'soft'
          ? 'bg-cream text-ink border border-line hover:bg-cream-deep'
          : variant === 'danger'
            ? 'bg-transparent text-clay border border-clay hover:bg-clay/15'
            : /* link */
              'text-ink underline underline-offset-4 decoration-ink/30 hover:decoration-ink px-0 normal-case tracking-normal';

  return (
    <button
      className={cn(base, variant !== 'link' && sizeCls, tone, fullWidth && 'w-full', className)}
      {...rest}
    >
      {iconLeft}
      {children}
      {iconRight}
    </button>
  );
}
