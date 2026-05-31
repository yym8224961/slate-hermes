import { cn } from '@/lib/cn';

export const fieldBaseCls = cn(
  'bg-cream/30 text-ink',
  'border-0 border-b-2 border-ink',
  'px-0 py-2',
  'transition-colors duration-150',
  'placeholder:text-stone',
  'focus-visible:!outline-none focus-visible:bg-cream/60',
  'hover:bg-cream/50',
  'disabled:opacity-40 disabled:cursor-not-allowed'
);

export const inputCls = cn('block w-full', 'font-serif text-[20px]', fieldBaseCls);
