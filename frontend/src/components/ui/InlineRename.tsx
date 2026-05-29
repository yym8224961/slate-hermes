import { Check, Pencil } from 'lucide-react';
import type { KeyboardEventHandler, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { inputCls } from '@/lib/styles';

export function InlineRename({
  editing,
  value,
  draft,
  onDraftChange,
  onStart,
  onCommit,
  onKeyDown,
  pending = false,
  maxLength = 64,
  placeholder,
  inputClassName,
  titleClassName,
  buttonClassName,
  editIconSize = 16,
  saveIconSize = 18,
  renderTitle,
}: {
  editing: boolean;
  value: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onStart: () => void;
  onCommit: () => void | Promise<void>;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
  pending?: boolean;
  maxLength?: number;
  placeholder?: string;
  inputClassName?: string;
  titleClassName: string;
  buttonClassName?: string;
  editIconSize?: number;
  saveIconSize?: number;
  renderTitle?: (value: string, className: string) => ReactNode;
}) {
  const label = editing ? '保存名称' : '改名';
  return (
    <div className="flex items-center gap-2 min-w-0">
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onBlur={() => {
            void Promise.resolve(onCommit()).catch(() => {});
          }}
          onKeyDown={onKeyDown}
          maxLength={maxLength}
          placeholder={placeholder}
          className={cn(inputCls, 'flex-1 min-w-0', inputClassName)}
        />
      ) : renderTitle ? (
        renderTitle(value, titleClassName)
      ) : (
        <h1 className={titleClassName}>{value}</h1>
      )}
      <button
        type="button"
        onMouseDown={(event) => {
          if (editing) event.preventDefault();
        }}
        onClick={() => {
          if (editing) void Promise.resolve(onCommit()).catch(() => {});
          else onStart();
        }}
        disabled={pending}
        aria-label={label}
        title={editing ? '保存' : '改名'}
        className={cn(
          'text-stone-light hover:text-ink disabled:opacity-50 transition-colors hover:bg-cream flex-shrink-0',
          buttonClassName
        )}
      >
        {editing ? <Check size={saveIconSize} /> : <Pencil size={editIconSize} />}
      </button>
    </div>
  );
}
