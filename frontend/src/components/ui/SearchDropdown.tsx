import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { inputCls } from '@/components/ui/styles/form';
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
  const listboxId = useId();
  const blurTimerRef = useRef<number | null>(null);
  const valueRef = useRef(value);
  const resultKeys = useMemo(() => results.map(getKey).join('\0'), [getKey, results]);
  const [activeResultKeys, setActiveResultKeys] = useState(resultKeys);
  const [activeIndex, setActiveIndex] = useState(0);
  const resultSetChanged = activeResultKeys !== resultKeys;
  const selectedIndex = resultSetChanged
    ? 0
    : Math.min(activeIndex, Math.max(results.length - 1, 0));

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (activeResultKeys !== resultKeys) {
      setActiveResultKeys(resultKeys);
      setActiveIndex(0);
      return;
    }
    setActiveIndex((index) => Math.min(index, Math.max(results.length - 1, 0)));
  }, [activeResultKeys, resultKeys, results.length]);

  useEffect(() => {
    return () => clearBlurTimer(blurTimerRef);
  }, []);

  function selectResult(item: Item) {
    clearBlurTimer(blurTimerRef);
    onSelect(item);
    onOpenChange(false);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      onOpenChange(false);
      return;
    }
    if (!results.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        onOpenChange(true);
        setActiveIndex(event.key === 'ArrowDown' ? 0 : results.length - 1);
        return;
      }
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => {
        const currentIndex = resultSetChanged ? 0 : index;
        return (currentIndex + offset + results.length) % results.length;
      });
      return;
    }
    if (event.key === 'Enter' && open) {
      event.preventDefault();
      const result = results[selectedIndex];
      if (result) selectResult(result);
    }
  }

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
          onKeyDown={onInputKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={open && results.length > 0 ? listboxId : undefined}
          aria-activedescendant={
            open && results.length > 0 ? `${listboxId}-${selectedIndex}` : undefined
          }
        />
      </label>
      {open && results.length === 0 && noResult}
      {open && results.length > 0 && (
        <div
          id={listboxId}
          role="listbox"
          className={cn(
            'absolute z-10 top-full mt-1 left-0 right-0 border border-ink bg-paper shadow',
            panelClassName
          )}
        >
          {results.map((result, index) => (
            <button
              key={getKey(result)}
              id={`${listboxId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={cn(
                'w-full text-left px-3 py-2 font-sans text-[13px] text-ink hover:bg-cream',
                index === selectedIndex && 'bg-cream'
              )}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectResult(result)}
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
