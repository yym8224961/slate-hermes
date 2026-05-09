// 统一的 icon 容器原子。
//
// 4 种尺寸 + 5 种语调,所有页 / 卡 / dialog 通过它出 icon 块。
//
// 尺寸阶梯:
//   sm  w-8  h-8  rounded-[10px]   列表小图标 / 内嵌
//   md  w-10 h-10 rounded-[12px]   卡片标准 (DeviceCard / GroupCard / Section badge / dialog header)
//   lg  w-14 h-14 rounded-[16px]   备用
//   xl  w-16 h-16 rounded-[18px]   GroupHeader 等强调位
//
// 语调:
//   brand   bg-clay     text-paper            logo 唯一
//   avatar  bg-saffron  text-ink (rounded-full)  用户头像唯一
//   soft    bg-cream-deep text-clay           默认(卡片/header/dialog header)
//   danger  bg-clay/15  text-clay             销毁性 / 警告
//   muted   bg-cream    text-stone            empty state / 弱化

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

type Size = 'sm' | 'md' | 'lg' | 'xl';
type Tone = 'brand' | 'avatar' | 'soft' | 'danger' | 'muted';

const SIZE: Record<Size, string> = {
  sm: 'w-8 h-8 rounded-[10px]',
  md: 'w-10 h-10 rounded-[12px]',
  lg: 'w-14 h-14 rounded-[16px]',
  xl: 'w-16 h-16 rounded-[18px]',
};

const TONE: Record<Tone, string> = {
  brand: 'bg-clay text-paper',
  avatar: 'bg-ink text-paper !rounded-full',
  soft: 'bg-cream-deep text-clay',
  danger: 'bg-clay/15 text-clay',
  muted: 'bg-cream text-stone',
};

interface IconBlockProps {
  size?: Size;
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
  'aria-label'?: string;
}

export function IconBlock({
  size = 'md',
  tone = 'soft',
  children,
  className,
  title,
  'aria-label': ariaLabel,
}: IconBlockProps) {
  return (
    <span
      title={title}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center justify-center flex-shrink-0',
        SIZE[size],
        TONE[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
