// Mono Press section 标题：衬线大字 + 双线分隔（替代波浪）。

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { IconBlock } from '@/components/ui/IconBlock';
import { DoubleRule } from '@/components/ui/DoubleRule';

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
      <header className="flex items-center gap-4">
        {badge && (
          <IconBlock size="lg" tone="soft">
            {badge}
          </IconBlock>
        )}
        <div className="flex-1 min-w-0">
          <h2 className="font-serif text-[26px] sm:text-[30px] leading-[1.2] text-ink truncate">
            {title}
          </h2>
          {subtitle && (
            <p className="font-sans text-[13px] text-stone mt-1.5 leading-relaxed max-w-xl">
              {subtitle}
            </p>
          )}
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </header>
      <DoubleRule className="mt-3" />
      <div className="mt-6">{children}</div>
    </section>
  );
}
