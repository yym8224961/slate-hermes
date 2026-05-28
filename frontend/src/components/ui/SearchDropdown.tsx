import { useEffect, useRef, type MutableRefObject, type ReactNode } from 'react';
import { inputCls } from '@/lib/styles';
import { cn } from '@/lib/cn';

interface SearchDropdownProps<Item> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  onFocus?: () => void;
  onBlurCommit?: (value: string) => void;
  placeholder?: string;
  results: Item[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  getKey: (item: Item) => string;
  onSelect: (item: Item) => void;
  renderItem: (item: Item) => ReactNode;
  noResult?: ReactNode;
  panelClassName?: string;
}

export function SearchDropdown<Item>({
  label,
  value,
  onValueChange,
  onFocus,
  onBlurCommit,
  placeholder,
  results,
  open,
  onOpenChange,
  getKey,
  onSelect,
  renderItem,
  noResult,
  panelClassName,
}: SearchDropdownProps<Item>) {
  const blurTimerRef = useRef<number | null>(null);
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    return () => clearBlurTimer(blurTimerRef);
  }, []);

  return (
    <div className="relative">
      <label className="block">
        <span className="block font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
          {label}
        </span>
        <input
          className={cn(inputCls, 'w-full')}
          value={value}
          onChange={(event) => {
            valueRef.current = event.target.value;
            onValueChange(event.target.value);
          }}
          onFocus={onFocus}
          onBlur={() => {
            clearBlurTimer(blurTimerRef);
            blurTimerRef.current = window.setTimeout(() => {
              blurTimerRef.current = null;
              onBlurCommit?.(valueRef.current);
              onOpenChange(false);
            }, 150);
          }}
          placeholder={placeholder}
          autoComplete="off"
        />
      </label>
      {open && noResult}
      {open && results.length > 0 && (
        <div
          className={cn(
            'absolute z-10 top-full mt-1 left-0 right-0 border border-ink bg-paper shadow',
            panelClassName
          )}
        >
          {results.map((result) => (
            <button
              key={getKey(result)}
              type="button"
              className="w-full text-left px-3 py-2 font-sans text-[13px] text-ink hover:bg-cream"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                clearBlurTimer(blurTimerRef);
                onSelect(result);
                onOpenChange(false);
              }}
            >
              {renderItem(result)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function clearBlurTimer(timerRef: MutableRefObject<number | null>) {
  if (timerRef.current === null) return;
  window.clearTimeout(timerRef.current);
  timerRef.current = null;
}
