import { fieldBaseCls } from '@/lib/styles';
import { cn } from '@/lib/cn';

export function JsonEditor({
  label,
  value,
  error,
  minRows,
  onChange,
  readOnly = false,
}: {
  label: string;
  value: string;
  error: string | null;
  minRows: number;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <label className="block">
      <span className="block font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
        {label}
      </span>
      <textarea
        className={cn(
          fieldBaseCls,
          'block w-full resize-y font-mono text-[11px] leading-relaxed px-2 py-2 !border !border-ink bg-cream/30'
        )}
        rows={minRows}
        value={value}
        spellCheck={false}
        readOnly={readOnly}
        onChange={(e) => onChange?.(e.target.value)}
      />
      {error && <p className="mt-1.5 font-sans text-[11px] text-clay">{error}</p>}
    </label>
  );
}
