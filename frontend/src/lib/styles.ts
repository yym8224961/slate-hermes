// Mono Press 控件公共样式。
//
// 输入控件一律用「下划线」风格：只有底部 2px 墨线，无 box、无圆角、
// 背景透明。与报刊排版风格一致。
//
// 改动这里 = 同时改全站所有输入控件。

export const fieldBaseCls = [
  'bg-cream/30 text-ink',
  'border-0 border-b-2 border-ink',
  'px-0 py-2',
  'transition-colors duration-150',
  'placeholder:text-stone',
  'focus-visible:!outline-none focus-visible:bg-cream/60',
  'hover:bg-cream/50',
  'disabled:opacity-40 disabled:cursor-not-allowed',
].join(' ');

// Input 组件:含字体 + 字号
export const inputCls = ['block w-full', 'font-serif text-[20px]', fieldBaseCls].join(' ');

// Radix Select trigger
export const selectTriggerCls = [
  'w-full inline-flex items-center justify-between gap-2',
  'px-4 py-3',
  'font-serif text-[16px]',
  'border border-ink bg-cream/30 text-ink',
  'transition-colors duration-150',
  'focus-visible:!outline-none focus-visible:bg-cream/60',
  'hover:bg-cream/50',
  'disabled:opacity-40 disabled:cursor-not-allowed',
].join(' ');

// Radix Select 弹层
export const selectContentCls = [
  'min-w-[var(--radix-select-trigger-width)]',
  'bg-paper border border-ink',
  'shadow-dropdown',
  'py-1 z-[60] overflow-hidden',
].join(' ');

// Radix Select 单条 item
export const selectItemCls = [
  'flex items-center gap-2 mx-1 px-3 py-2 text-[14px]',
  'cursor-pointer outline-none',
  'hover:bg-cream',
  'data-[highlighted]:bg-cream',
  'data-[state=checked]:text-ink data-[state=checked]:font-medium data-[state=checked]:bg-cream-deep',
].join(' ');

// Dialog 弹层内容
export const dialogContentCls = [
  'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
  'w-[calc(100vw-2rem)] max-w-md',
  'bg-paper border-2 border-ink',
  'z-50 p-7',
  'shadow-dialog',
].join(' ');

// Dialog 弹层内容(宽版)
export const dialogContentWideCls = [
  'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
  'w-[calc(100vw-2rem)] max-w-xl max-h-[calc(100vh-3rem)]',
  'flex flex-col',
  'bg-paper border-2 border-ink',
  'z-50',
  'shadow-dialog',
].join(' ');

// Dialog 遮罩
export const dialogOverlayCls = 'fixed inset-0 bg-ink/20 z-40';

// Dialog 遮罩(confirm 用,更高层级)
export const dialogOverlayConfirmCls = 'fixed inset-0 bg-ink/20 z-50';

// Dialog 弹层内容(confirm 用,比普通 dialog 高一档 z-index)
export const dialogContentConfirmCls = [
  'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
  'w-[calc(100vw-2rem)] max-w-md',
  'bg-paper border-2 border-ink',
  'z-[60] p-6',
  'shadow-dialog',
].join(' ');
