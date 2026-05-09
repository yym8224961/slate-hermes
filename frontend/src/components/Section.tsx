// Soft-craft 节标题：楷书大字中文 + 砖红 ▸ 装饰 + 副标楷体小字。
// 没有 editorial 的「双线分隔」，改成温柔的波浪线。响应式同上。

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { IconBlock } from './IconBlock';

interface SectionProps {
  title: string;
  subtitle?: string;
  /** 中文标题前的小图标(emoji 或 lucide,可选) */
  badge?: ReactNode;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function Section({ title, subtitle, badge, action, className, children }: SectionProps) {
  return (
    <section className={cn('mt-12 first:mt-8', className)}>
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 sm:gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            {badge && <IconBlock tone="soft">{badge}</IconBlock>}
            <h2 className="font-kai text-[26px] sm:text-[30px] leading-[1.2] text-ink">{title}</h2>
          </div>
          {subtitle && (
            <p className="font-sans text-[14px] text-stone mt-1.5 leading-relaxed">{subtitle}</p>
          )}
        </div>
        {action && <div className="flex items-center gap-3 flex-shrink-0">{action}</div>}
      </header>
      <div className="wave-divider mt-5" />
      <div className="mt-6">{children}</div>
    </section>
  );
}
