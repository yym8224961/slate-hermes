import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { IconBlock } from '@/components/ui/IconBlock';
import { DoubleRule } from '@/components/ui/DoubleRule';

interface PageHeaderProps {
  backLabel?: string;
  onBack: () => void;
  icon: ReactNode;
  title: ReactNode;
  titleContent?: ReactNode;
  subtitle: ReactNode;
  action?: ReactNode;
}

export function PageHeader({
  backLabel = '返回',
  onBack,
  icon,
  title,
  titleContent,
  subtitle,
  action,
}: PageHeaderProps) {
  return (
    <>
      <nav>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-[11px] font-mono text-stone hover:text-ink tracking-[0.08em]"
        >
          <ArrowLeft size={14} /> {backLabel}
        </button>
      </nav>

      <header className="mt-5 fade-up flex items-center gap-4">
        <IconBlock size="lg" tone="soft">
          {icon}
        </IconBlock>
        <div className="flex-1 min-w-0">
          {titleContent ?? (
            <h1 className="font-serif text-[32px] sm:text-[40px] font-bold leading-[1.2] truncate tracking-tight">
              {title}
            </h1>
          )}
          <p className="font-sans text-[13px] text-stone mt-1.5 leading-relaxed">{subtitle}</p>
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </header>

      <DoubleRule className="mt-3" />
    </>
  );
}
