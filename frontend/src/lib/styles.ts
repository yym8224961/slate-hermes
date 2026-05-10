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
  'px-0 py-2',
  'font-serif text-[16px]',
  'border-0 border-b-2 border-ink bg-cream/30 text-ink',
  'transition-colors duration-150',
  'focus-visible:!outline-none focus-visible:bg-cream/60',
  'hover:bg-cream/50',
  'data-[state=open]:border-b-[3px] data-[state=open]:pb-[7px]',
  'disabled:opacity-40 disabled:cursor-not-allowed',
].join(' ');

// Radix Select 弹层
export const selectContentCls = [
  'min-w-[var(--radix-select-trigger-width)]',
  'bg-paper border border-ink',
  'shadow-[0_8px_24px_rgba(20,17,13,0.14)]',
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
