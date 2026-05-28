import { useLayoutEffect, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { TYPE_ITEMS, type AllContentType } from '@/features/contents/model/type-meta';
import { cn } from '@/lib/cn';

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
                    'h-10 min-w-[140px] shrink-0 border border-ink px-4 inline-flex items-center justify-center gap-2 font-sans text-[12px] transition-colors',
                    selected ? 'bg-ink text-paper' : 'hover:bg-cream'
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
