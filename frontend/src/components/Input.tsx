// Mono Press input：下划线风格，label 用 mono uppercase。

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
        <span className="block font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
          {label}
        </span>
      )}
      <input
        ref={ref}
        className={cn(inputCls, error && '!border-clay focus-visible:!outline-clay', className)}
        {...rest}
      />
      {hint && !error && (
        <span className="block font-sans text-[11px] text-stone mt-1.5">{hint}</span>
      )}
      {error && <span className="block font-sans text-[11px] text-clay mt-1.5">{error}</span>}
    </label>
  );
});
