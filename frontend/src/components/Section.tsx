// Mono Press section 标题：衬线大字 + 双线分隔（替代波浪）。

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { IconBlock } from './IconBlock';

interface SectionProps {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function Section({ title, subtitle, badge, action, className, children }: SectionProps) {
  return (
    <section className={cn('mt-12 first:mt-8', className)}>
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            {badge && <IconBlock tone="soft">{badge}</IconBlock>}
            <h2 className="font-serif text-[26px] sm:text-[30px] leading-[1.2] text-ink">
              {title}
            </h2>
          </div>
          {subtitle && (
            <p className="font-sans text-[13px] text-stone mt-1.5 leading-relaxed max-w-xl">
              {subtitle}
            </p>
          )}
        </div>
        {action && <div className="flex items-center gap-3 flex-shrink-0">{action}</div>}
      </header>
      {/* 双线分隔：1px + 3px 间隔 + 2px */}
      <div className="mt-5 flex flex-col gap-[3px]">
        <div className="h-px bg-ink" />
        <div className="h-0.5 bg-ink" />
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}
