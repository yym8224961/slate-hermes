import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface DeviceMetaCardProps {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  mono?: boolean;
  warn?: boolean;
  hint?: string;
  stale?: boolean;
}

export function DeviceMetaCard({
  icon,
  label,
  value,
  mono,
  warn,
  hint,
  stale,
}: DeviceMetaCardProps) {
  return (
    <div
      className={cn(
        'craft-card px-3.5 py-3 transition-opacity',
        warn && '!border-clay',
        stale && 'opacity-50'
      )}
    >
      <div className="flex items-center gap-1.5 text-stone">
        {icon}
        <span className="text-[11px]">{label}</span>
      </div>
      <p
        className={cn(
          'mt-1 text-ink',
          warn && 'text-clay',
          mono ? 'font-mono text-[12px] tabular-nums truncate' : 'font-serif text-[16px]'
        )}
      >
        {value}
      </p>
      {hint && <p className="font-sans text-[10px] text-stone-light mt-0.5">{hint}</p>}
    </div>
  );
}
