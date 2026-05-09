// 控件公共样式常量。
//
// 所有「可输入 / 可选择」控件 (Input、Radix Select trigger、inline rename
// input、textarea …) 共用同一套 affordance,保证用户在 paper / cream 背景
// 上一眼能认出"这是个可交互区"。
//
// 视觉契约 — 三段式,每一档都比上一档「更显著」一档:
//   默认 → bg-cream-deep + 1px stone-light border + 全周 1px inset shadow
//          (双重边视觉:远看是软细边,近看 ~1.5px,在 paper/cream 暖色底上
//           稳稳浮出"这是输入区";关键是 inset shadow 用 spread=1px 0 0 0,
//           四边对称,不是只压顶部那种"半边凹陷")
//   hover → border 加深到 stone(暖棕),inset 同步加深,提示"可以点"
//   focus → 清 inset shadow → 换 4px clay/15 外发光 ring + bg 升 paper
//          (inset 让位给 outset ring,激活感最强;不能用 ring-inset 做默认
//           态 — Tailwind v4 的 --tw-ring-inset 不会被 focus:ring-4 自动
//           重置,会导致 focus 也是内描 4px 而非外发光)
//
// 不用 border-2 做"加厚"的原因:整页 form 一加粗就"块化",失去"案头"克制感;
// 1px border + 1px inset 的复合边在远看仍是软细边,近看才看出是双层。
//
// 改动这里 = 同时改全站所有输入控件,不要在组件里另写 bg/border/ring/shadow。

export const fieldBaseCls = [
  'bg-cream-deep text-ink',
  'rounded-[12px] border border-stone-light',
  'shadow-[inset_0_0_0_1px_rgba(184,168,144,0.35)]', // stone-light @ 35%
  'transition-all duration-150',
  'hover:border-stone hover:shadow-[inset_0_0_0_1px_rgba(139,113,86,0.30)]', // stone @ 30%
  'focus:outline-none focus:border-clay focus:ring-4 focus:ring-clay/15 focus:bg-paper focus:shadow-none',
  'disabled:opacity-50 disabled:cursor-not-allowed',
].join(' ');

// Input/textarea 用的:含 padding + placeholder 颜色 + 字号
export const inputCls = [
  'block w-full px-4 py-2.5',
  'font-sans text-[15px]',
  'placeholder:text-stone-light',
  fieldBaseCls,
].join(' ');

// Radix Select trigger:在 fieldBaseCls 之上加 flex/justify-between + open
// 状态(open 时 trigger 应像 focus 一样高亮 — 因为 :focus 这时已让位给
// listbox,不写 data-[state=open] 的话 trigger 反而失焦看起来"未聚焦")
export const selectTriggerCls = [
  'w-full inline-flex items-center justify-between gap-2',
  'px-4 py-2.5',
  'data-[state=open]:border-clay data-[state=open]:ring-4 data-[state=open]:ring-clay/15 data-[state=open]:bg-paper data-[state=open]:shadow-none',
  fieldBaseCls,
].join(' ');

// Radix Select 弹层(content/viewport 容器)
export const selectContentCls = [
  'min-w-[var(--radix-select-trigger-width)]',
  'bg-paper border border-line rounded-[14px]',
  'shadow-[0_12px_32px_rgba(61,40,23,0.12)]',
  'py-1.5 z-[60] overflow-hidden',
].join(' ');

// Radix Select 单条 item
export const selectItemCls = [
  'flex items-center gap-2 mx-1.5 px-3 py-2 text-[14px]',
  'rounded-[10px] cursor-pointer outline-none',
  'hover:bg-cream',
  'data-[highlighted]:bg-cream',
  'data-[state=checked]:text-clay data-[state=checked]:bg-cream-deep/60',
].join(' ');
