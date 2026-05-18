import { useLayoutEffect, useRef } from 'react';
import {
  ArrowLeft,
  Image as ImageIcon,
  Calendar,
  CalendarDays,
  CloudSun,
  BookText,
  BarChart3,
  Type,
} from 'lucide-react';
import type { AllContentType } from './content-create-types';
import { cn } from '@/lib/cn';

const TYPE_ITEMS: Array<{
  type: AllContentType;
  title: string;
  hint: string;
  Icon: typeof ImageIcon;
}> = [
  {
    type: 'image',
    title: '图片',
    hint: '上传图片，自动转 1bpp',
    Icon: ImageIcon,
  },
  {
    type: 'daily_calendar',
    title: '日历',
    hint: '日期 · 星期 · 农历 · 节气',
    Icon: Calendar,
  },
  {
    type: 'month_calendar',
    title: '月历',
    hint: '整月日期 · 农历 · 节日',
    Icon: CalendarDays,
  },
  {
    type: 'weather',
    title: '天气',
    hint: '实时气温 / 湿度 / 风速',
    Icon: CloudSun,
  },
  {
    type: 'history_today',
    title: '历史上的今天',
    hint: '今日历史大事，每日 0 点更新',
    Icon: BookText,
  },
  {
    type: 'dashboard',
    title: '数据看板',
    hint: '外部 POST 数据，立即刷新',
    Icon: BarChart3,
  },
  {
    type: 'font_test',
    title: '字体测试',
    hint: '切换字体 · 查看 1bpp 字形',
    Icon: Type,
  },
];

export function ContentTypeCardGrid({ onChange }: { onChange: (t: AllContentType) => void }) {
  return (
    <div className="grid min-w-0 grid-cols-2 sm:grid-cols-3 lg:grid-cols-[repeat(3,minmax(0,1fr))] gap-3">
      {TYPE_ITEMS.map((it) => (
        <button
          key={it.type}
          type="button"
          onClick={() => onChange(it.type)}
          className="craft-card flex flex-col items-start gap-2 p-4 text-left transition-all hover:bg-cream"
        >
          <it.Icon size={22} />
          <span className="font-serif text-[18px] leading-none">{it.title}</span>
          <span className="font-sans text-[12px] leading-snug text-stone">{it.hint}</span>
        </button>
      ))}
    </div>
  );
}

export function ContentTypePicker({
  value,
  onChange,
  onBack,
}: {
  value: AllContentType;
  onChange: (t: AllContentType) => void;
  onBack: () => void;
}) {
  const selectedButtonRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    selectedButtonRef.current?.scrollIntoView({
      block: 'nearest',
      inline: 'center',
      behavior: 'auto',
    });
  }, []);

  return (
    <div className="flex min-w-0 items-stretch gap-2">
      <button
        type="button"
        onClick={onBack}
        aria-label="返回类型卡片选择"
        title="返回类型卡片选择"
        className="h-10 w-10 shrink-0 border border-ink inline-flex items-center justify-center text-stone hover:bg-cream hover:text-ink transition-colors"
      >
        <ArrowLeft size={15} />
      </button>
      <div className="content-type-scroll-frame relative min-w-0 flex-1">
        <div className="content-type-scroll min-w-0 overflow-x-auto">
          <div className="flex min-w-max gap-2 px-1">
            {TYPE_ITEMS.map((it) => {
              const selected = value === it.type;
              return (
                <button
                  key={it.type}
                  ref={selected ? selectedButtonRef : undefined}
                  type="button"
                  onClick={() => onChange(it.type)}
                  aria-pressed={selected}
                  className={cn(
                    'h-10 min-w-[128px] shrink-0 border px-4 inline-flex items-center justify-center gap-2 font-sans text-[12px] transition-colors',
                    selected ? 'bg-ink text-paper border-ink' : 'hover:bg-cream'
                  )}
                >
                  <it.Icon size={15} className="shrink-0" />
                  <span className="min-w-0 truncate leading-none">{it.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
