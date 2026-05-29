// 心跳三点 — 砖红呼吸圆点(替代 ASCII spinner)。

import { cn } from '@/lib/cn';

interface SpinnerProps {
  label?: string;
  className?: string;
}

export function Spinner({ label, className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label ?? '加载中'}
      className={cn('inline-flex items-center gap-2.5', className)}
    >
      <span className="inline-flex items-center" aria-hidden="true">
        <span className="heart-dot" />
        <span className="heart-dot" />
        <span className="heart-dot" />
      </span>
      {label && <span className="text-stone text-[13px]">{label}</span>}
    </span>
  );
}
