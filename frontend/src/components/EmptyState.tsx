// 空状态:楷书提示 + 副标 + 可选 action。
// icon 走 IconBlock(size lg / tone muted),与 Section badge / 卡片 icon 同体系。

import type { ReactNode } from 'react';
import { IconBlock } from './IconBlock';
import { cn } from '../lib/cn';

interface EmptyStateProps {
  title: string;
  hint?: string;
  /** lucide 图标(显示在标题上方) */
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, hint, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cn('py-16 text-center', className)}>
      {icon && (
        <div className="inline-flex mb-4">
          <IconBlock size="lg" tone="muted">
            {icon}
          </IconBlock>
        </div>
      )}
      <p className="font-kai text-[20px] text-ink">{title}</p>
      {hint && (
        <p className="text-[14px] text-stone mt-2 max-w-md mx-auto leading-relaxed">{hint}</p>
      )}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}
