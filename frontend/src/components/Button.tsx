// Soft-craft 按钮:大圆角(radius-md/lg)、实色 + 微浮、active 下沉。
// primary 是砖红主色,outline 描边,danger 用更深砖红+苔绿对比。

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

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
      ? 'h-9 px-3.5 text-[13px] gap-1.5 rounded-[10px]'
      : size === 'lg'
        ? 'h-12 px-6 text-[15px] gap-2.5 rounded-[16px]'
        : 'h-10 px-4 text-[14px] gap-2 rounded-[14px]';

  // sm 视觉是 36px,但触摸目标推荐 ≥44px。用伪元素扩出 4px 透明热区,
  // 不影响视觉尺寸,只放大点击/触摸命中范围。
  const touchExtend =
    size === 'sm' ? 'relative before:absolute before:inset-[-4px] before:content-[""]' : '';

  const base =
    'inline-flex items-center justify-center font-sans font-medium ' +
    'transition-all duration-200 select-none ' +
    'disabled:cursor-not-allowed disabled:opacity-40';

  const tone =
    variant === 'primary'
      ? 'bg-clay text-paper shadow-[0_3px_10px_-2px_rgba(184,84,54,0.35)] hover:bg-ink hover:shadow-[0_3px_10px_-2px_rgba(61,40,23,0.35)] active:translate-y-px'
      : variant === 'outline'
        ? 'bg-paper text-ink border border-ink/15 hover:border-ink/40 hover:bg-cream active:translate-y-px'
        : variant === 'soft'
          ? 'bg-cream text-ink hover:bg-cream-deep active:translate-y-px'
          : variant === 'danger'
            ? 'bg-paper text-clay border border-clay/30 hover:bg-clay hover:text-paper hover:border-clay active:translate-y-px'
            : /* link */
              'text-clay underline underline-offset-4 decoration-clay/30 hover:decoration-clay px-0';

  return (
    <button
      className={cn(
        base,
        variant !== 'link' && sizeCls,
        variant !== 'link' && touchExtend,
        tone,
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
}
