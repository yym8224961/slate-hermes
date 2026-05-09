// Soft-craft input。所有「看上去是输入框」的样式集中在 lib/styles.ts 里
// (Select trigger / inline rename input / textarea 都共用),保证 affordance
// 一致 — 改这里也别忘了同步那边。

import { forwardRef, type InputHTMLAttributes } from 'react';
import { inputCls } from '../lib/styles';
import { cn } from '../lib/cn';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, className, ...rest },
  ref
) {
  return (
    <label className="block">
      {label && (
        <span className="block font-sans text-[13px] text-stone mb-1.5 ml-0.5">{label}</span>
      )}
      <input
        ref={ref}
        className={cn(
          inputCls,
          // error 用实色 clay border + 微 clay-tinted bg,与默认态的"实色"
          // 节奏一致(默认 stone-light 实 → error clay 实)
          error && '!border-clay !bg-clay/[0.04] focus:!ring-clay/20',
          className
        )}
        {...rest}
      />
      {hint && !error && (
        <span className="block font-sans text-[12px] text-stone mt-1.5 ml-0.5">{hint}</span>
      )}
      {error && (
        <span className="block font-sans text-[12px] text-clay mt-1.5 ml-0.5">{error}</span>
      )}
    </label>
  );
});
