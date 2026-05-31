import { BatteryFull, Wifi } from 'lucide-react';
import { cn } from '@/lib/cn';

interface StatusBarOverlayProps {
  caption?: string | null;
  className?: string;
}

const STATUS_BAR_HEIGHT_PCT = (24 / 300) * 100;

export function StatusBarOverlay({ caption, className }: StatusBarOverlayProps) {
  return (
    <div
      className={cn(
        'absolute top-0 left-0 right-0 z-10 flex items-center justify-between gap-2 bg-paper/95 px-[2%] text-ink border-b border-ink/35 pointer-events-none',
        className
      )}
      style={{ height: `${STATUS_BAR_HEIGHT_PCT}%` }}
      aria-hidden="true"
    >
      <Wifi size={14} className="shrink-0" strokeWidth={2} />
      <span className="min-w-0 flex-1 truncate text-center font-serif text-[11px] leading-none">
        {caption || '\u00a0'}
      </span>
      <BatteryFull size={15} className="shrink-0" strokeWidth={2} />
    </div>
  );
}
