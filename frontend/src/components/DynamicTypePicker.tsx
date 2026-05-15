// 动态内容类型选择 grid。4 个 tile，0 圆角 ink 边框，hover 反相。

import { Calendar, CloudSun, BookText, BarChart3 } from 'lucide-react';
import type { DynamicTypeT } from 'shared';
import { cn } from '../lib/cn';

interface Item {
  type: DynamicTypeT;
  title: string;
  hint: string;
  Icon: typeof Calendar;
}

const ITEMS: Item[] = [
  { type: 'date', title: '日期', hint: '公历 · 星期 · 农历 · 节气', Icon: Calendar },
  { type: 'weather', title: '天气', hint: '实时气温 / 湿度 / 风速', Icon: CloudSun },
  {
    type: 'history_today',
    title: '历史上的今天',
    hint: '今日历史大事，每日 0 点更新',
    Icon: BookText,
  },
  { type: 'dashboard', title: '数据看板', hint: '外部 POST 数据，立即刷新', Icon: BarChart3 },
];

export function DynamicTypePicker({
  value,
  onChange,
  disabled,
}: {
  value: DynamicTypeT | null;
  onChange: (t: DynamicTypeT) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {ITEMS.map((it) => {
        const selected = value === it.type;
        return (
          <button
            key={it.type}
            type="button"
            onClick={() => !disabled && onChange(it.type)}
            disabled={disabled}
            className={cn(
              'craft-card flex flex-col items-start gap-2 p-4 text-left transition-all',
              selected ? 'bg-ink text-paper border-ink' : 'hover:bg-cream',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            <it.Icon size={22} />
            <span className="font-serif text-[18px] leading-none">{it.title}</span>
            <span
              className={cn(
                'font-sans text-[12px] leading-snug',
                selected ? 'text-paper/70' : 'text-stone'
              )}
            >
              {it.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}
