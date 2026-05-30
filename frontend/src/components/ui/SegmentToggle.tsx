import { useEffect, useRef, type ReactNode } from 'react';
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
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    buttonRefs.current.length = options.length;
  }, [options.length]);

  function focusOption(index: number) {
    const next = options[index];
    if (!next) return;
    onChange(next.value);
    window.requestAnimationFrame(() => {
      buttonRefs.current[index]?.focus();
    });
  }

  return (
    <div role="radiogroup" className={cn('flex border-b border-line', className)}>
      {options.map((o, index) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            ref={(node) => {
              buttonRefs.current[index] = node;
            }}
            onClick={() => onChange(o.value)}
            onKeyDown={(event) => {
              if (
                event.key !== 'ArrowRight' &&
                event.key !== 'ArrowDown' &&
                event.key !== 'ArrowLeft' &&
                event.key !== 'ArrowUp'
              ) {
                return;
              }
              event.preventDefault();
              const offset = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
              focusOption((index + offset + options.length) % options.length);
            }}
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
