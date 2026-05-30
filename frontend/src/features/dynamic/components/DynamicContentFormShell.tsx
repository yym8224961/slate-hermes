import type { FormEvent, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function DynamicContentFormShell({
  onSubmit,
  preview,
  header,
  fields,
  actions,
  gridClassName,
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  preview: ReactNode;
  header: ReactNode;
  fields?: ReactNode;
  actions?: ReactNode;
  gridClassName?: string;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className={cn('grid grid-cols-1 gap-6 lg:gap-8', gridClassName ?? 'lg:grid-cols-[1.3fr_1fr]')}
    >
      <div className="order-2 min-w-0 lg:order-1">
        <p className="font-mono text-[10px] leading-5 text-stone uppercase tracking-[0.18em] ml-0.5 mb-2">
          设备预览
        </p>
        {preview}
      </div>

      <div className="order-1 min-w-0 lg:order-2 lg:mt-7 space-y-6">
        {header}
        {fields}
        {actions}
      </div>
    </form>
  );
}
