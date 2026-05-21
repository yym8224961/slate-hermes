import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
}

interface SegmentToggleProps<V extends string> {
  value: V;
  onChange: (v: V) => void;
  options: SegmentOption<V>[];
  className?: string;
}

export function SegmentToggle<V extends string>({
  value,
  onChange,
  options,
  className,
}: SegmentToggleProps<V>) {
  return (
    <div role="radiogroup" className={cn('flex border-b border-line', className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex-1 pb-2 -mb-px inline-flex items-center justify-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors',
              active
                ? 'text-ink border-b-2 border-ink'
                : 'text-stone hover:text-ink border-b-2 border-transparent'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
