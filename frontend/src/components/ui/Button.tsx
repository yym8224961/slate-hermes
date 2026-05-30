// Mono Press 按钮：0px 圆角、uppercase 字母间距、实心墨 / 描边 / 危险三变体。

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

type ButtonVariant = 'primary' | 'outline' | 'soft' | 'link' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-9 px-3.5 text-[11px] gap-1.5',
  md: 'h-10 px-4 text-[12px] gap-2',
  lg: 'h-14 px-6 text-[13px] gap-2.5',
};

const TONE: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-paper border border-ink hover:bg-stone active:bg-stone',
  outline: 'bg-transparent text-ink border border-ink hover:bg-cream-deep active:bg-cream-deep',
  soft: 'bg-cream text-ink border border-line hover:bg-cream-deep',
  danger: 'bg-transparent text-clay border border-clay hover:bg-clay/15',
  link: 'text-ink underline underline-offset-4 decoration-ink/30 hover:decoration-ink px-0 normal-case tracking-normal',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    type = 'button',
    variant = 'primary',
    size = 'md',
    fullWidth,
    iconLeft,
    iconRight,
    className,
    children,
    ...rest
  },
  ref
) {
  const base =
    'inline-flex items-center justify-center font-sans font-medium ' +
    'uppercase tracking-[0.2em] ' +
    'transition-colors duration-150 select-none ' +
    'disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        base,
        variant !== 'link' && SIZE[size],
        TONE[variant],
        fullWidth && 'w-full',
        className
      )}
      {...rest}
    >
      {iconLeft}
      {children}
      {iconRight}
    </button>
  );
});
