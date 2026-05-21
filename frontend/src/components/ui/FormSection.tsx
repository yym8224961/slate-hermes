import type { ReactNode } from 'react';

interface FormSectionProps {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}

export function FormSection({ label, hint, children }: FormSectionProps) {
  return (
    <section>
      <p className="font-mono text-[10px] leading-5 text-stone uppercase tracking-[0.18em]">
        {label}
      </p>
      {hint && (
        <div className="mt-1.5 font-sans text-[12px] text-stone leading-relaxed">{hint}</div>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}
