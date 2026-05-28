// Mono Press 控件公共样式。
//
// 输入控件一律用「下划线」风格：只有底部 2px 墨线，无 box、无圆角、
// 背景透明。与报刊排版风格一致。
//
// 改动这里 = 同时改全站所有输入控件。

import { cn } from './cn';

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

// Input 组件:含字体 + 字号
export const inputCls = cn('block w-full', 'font-serif text-[20px]', fieldBaseCls);

// Radix Select trigger
export const selectTriggerCls = cn(
  'w-full inline-flex items-center justify-between gap-2',
  'px-4 py-3',
  'font-serif text-[16px]',
  'border border-ink bg-cream/30 text-ink',
  'transition-colors duration-150',
  'focus-visible:!outline-none focus-visible:bg-cream/60',
  'hover:bg-cream/50',
  'disabled:opacity-40 disabled:cursor-not-allowed'
);

// Radix Select 弹层
export const selectContentCls = cn(
  'w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]',
  'bg-paper border border-ink',
  'shadow-dropdown',
  'py-1 z-[60] overflow-hidden',
  'outline-none focus-visible:!outline-none'
);

export const selectViewportCls = cn(
  'max-h-[min(22rem,var(--radix-select-content-available-height))]',
  'overflow-y-auto',
  'outline-none focus-visible:!outline-none'
);

// Radix Select 单条 item
export const selectItemCls = cn(
  'flex min-w-0 items-center gap-2 mx-1 px-3 py-2 text-[14px]',
  'cursor-pointer outline-none focus-visible:!outline-none',
  'hover:bg-cream',
  'data-[highlighted]:bg-cream',
  'data-[state=checked]:text-ink data-[state=checked]:font-medium data-[state=checked]:bg-cream-deep'
);

const dialogContentFrameCls = cn(
  'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
  'w-[calc(100vw-2rem)]',
  'bg-paper border-2 border-ink',
  'shadow-dialog'
);

// Dialog 弹层内容
export const dialogContentCls = cn(dialogContentFrameCls, 'max-w-md z-50 p-7');

// Dialog 弹层内容（宽版）。
export const dialogContentWideCls = cn(
  dialogContentFrameCls,
  'max-w-xl max-h-[calc(100vh-3rem)]',
  'flex flex-col',
  'z-50'
);

// Dialog 遮罩
export const dialogOverlayCls = 'fixed inset-0 bg-ink/20 z-40';

// Dialog 遮罩(confirm 用,更高层级)
export const dialogOverlayConfirmCls = 'fixed inset-0 bg-ink/20 z-50';

// Dialog 弹层内容(confirm 用,比普通 dialog 高一档 z-index)
export const dialogContentConfirmCls = cn(dialogContentFrameCls, 'max-w-md', 'z-[60] p-6');
