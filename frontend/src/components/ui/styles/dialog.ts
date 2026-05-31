import { cn } from '@/lib/cn';

const dialogContentFrameCls = cn(
  'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
  'w-[calc(100vw-2rem)]',
  'bg-paper border-2 border-ink',
  'shadow-dialog'
);

export const dialogContentCls = cn(dialogContentFrameCls, 'max-w-md z-50 p-7');

export const dialogContentConfirmCls = cn(dialogContentFrameCls, 'max-w-md z-[60] p-6');

export const dialogContentWideCls = cn(
  dialogContentFrameCls,
  'max-w-xl max-h-[calc(100vh-3rem)]',
  'flex flex-col',
  'z-50'
);

export const dialogOverlayCls = 'fixed inset-0 bg-ink/20 z-40';

export const dialogOverlayConfirmCls = 'fixed inset-0 bg-ink/20 z-50';
