import { cls } from '@/lib/cn';

const dialogContentFrameCls = cls(
  'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
  'w-[calc(100vw-2rem)]',
  'bg-paper border-2 border-ink',
  'shadow-dialog'
);

export const dialogContentCls = cls(dialogContentFrameCls, 'max-w-md z-50 p-7');

export const dialogContentConfirmCls = cls(dialogContentFrameCls, 'max-w-md z-[60] p-6');

export const dialogContentWideCls = cls(
  dialogContentFrameCls,
  'max-w-xl max-h-[calc(100vh-3rem)]',
  'flex flex-col',
  'z-50'
);

export const dialogOverlayCls = 'fixed inset-0 bg-ink/20 z-40';

export const dialogOverlayConfirmCls = 'fixed inset-0 bg-ink/20 z-50';

export const fieldBaseCls = cls(
  'bg-cream/30 text-ink',
  'border-0 border-b-2 border-ink',
  'px-0 py-2',
  'transition-colors duration-150',
  'placeholder:text-stone',
  'focus-visible:!outline-none focus-visible:bg-cream/60',
  'hover:bg-cream/50',
  'disabled:opacity-40 disabled:cursor-not-allowed'
);

export const inputCls = cls('block w-full', 'font-serif text-[20px]', fieldBaseCls);
