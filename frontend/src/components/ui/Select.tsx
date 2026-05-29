// 统一的 Select 组件 — Radix Select 包一层,trigger / content / item 都
// 走 lib/styles.ts 里的常量,与 Input 同款 affordance。
//
// 单值受控用法:
//   <Select value={v} onValueChange={setV} placeholder="未选">
//     <SelectItem value="a">A</SelectItem>
//     <SelectItem value="b" hint="2 项">B</SelectItem>
//   </Select>
//
// 需要分隔条:<SelectSeparator />
//
// 这个组件刻意不做「options[]」那种 declarative 数据驱动 — 因为 GroupSelector
// 的「未选组」item 与正常 group items 之间需要一根分隔线，而 DitherControls
// 不需要。children 形式让两者复用 trigger 但保留各自结构自由度。

import { type ReactNode } from 'react';
import * as RS from '@radix-ui/react-select';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/cn';

interface SelectProps {
  value: string;
  onValueChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  children: ReactNode;
}

export function Select({
  value,
  onValueChange,
  placeholder,
  disabled,
  className,
  'aria-label': ariaLabel,
  children,
}: SelectProps) {
  return (
    <RS.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RS.Trigger aria-label={ariaLabel} className={cn(selectTriggerCls, className)}>
        <RS.Value placeholder={placeholder} />
        <RS.Icon>
          {/* chevron 用 stone(暖棕)而非 stone-light:在 cream-deep 底上后者
              几乎被吃掉,失去"这是下拉框"的视觉暗示 */}
          <ChevronDown size={14} className="text-ink" />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content position="popper" sideOffset={6} className={selectContentCls}>
          <RS.ScrollUpButton className="flex h-5 items-center justify-center bg-paper text-stone outline-none focus-visible:!outline-none">
            <ChevronDown size={13} className="rotate-180" />
          </RS.ScrollUpButton>
          <RS.Viewport className={selectViewportCls}>{children}</RS.Viewport>
          <RS.ScrollDownButton className="flex h-5 items-center justify-center bg-paper text-stone outline-none focus-visible:!outline-none">
            <ChevronDown size={13} />
          </RS.ScrollDownButton>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}

interface SelectItemProps {
  value: string;
  children: ReactNode;
  /** 右侧灰字小注(如 "12 帧") */
  hint?: ReactNode;
  className?: string;
}

export function SelectItem({ value, children, hint, className }: SelectItemProps) {
  return (
    <RS.Item value={value} className={cn(selectItemCls, className)}>
      <RS.ItemText>
        <span className="block truncate">{children}</span>
      </RS.ItemText>
      {hint != null && (
        <span className="ml-auto shrink-0 font-mono text-[11px] text-stone-light">{hint}</span>
      )}
      {/* 选中标记:右侧 check,与 hint 共存时排在 hint 之后 */}
      <RS.ItemIndicator className="ml-1 shrink-0 text-ink">
        <Check size={13} strokeWidth={2.5} />
      </RS.ItemIndicator>
    </RS.Item>
  );
}

export function SelectSeparator() {
  return <RS.Separator className="h-px bg-line my-1 mx-3" />;
}

const selectTriggerCls = cn(
  'w-full inline-flex items-center justify-between gap-2',
  'px-4 py-3',
  'font-serif text-[16px]',
  'border border-ink bg-cream/30 text-ink',
  'transition-colors duration-150',
  'focus-visible:!outline-none focus-visible:bg-cream/60',
  'hover:bg-cream/50',
  'disabled:opacity-40 disabled:cursor-not-allowed'
);

const selectContentCls = cn(
  'w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]',
  'bg-paper border border-ink',
  'shadow-dropdown',
  'py-1 z-[60] overflow-hidden',
  'outline-none focus-visible:!outline-none'
);

const selectViewportCls = cn(
  'max-h-[min(22rem,var(--radix-select-content-available-height))]',
  'overflow-y-auto',
  'outline-none focus-visible:!outline-none'
);

const selectItemCls = cn(
  'flex min-w-0 items-center gap-2 mx-1 px-3 py-2 text-[14px]',
  'cursor-pointer outline-none focus-visible:!outline-none',
  'hover:bg-cream',
  'data-[highlighted]:bg-cream',
  'data-[state=checked]:text-ink data-[state=checked]:font-medium data-[state=checked]:bg-cream-deep'
);
