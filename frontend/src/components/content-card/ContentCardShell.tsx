import type { CSSProperties, ReactNode } from 'react';
import { FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import { Spinner } from '../Spinner';
import { cn } from '../../lib/cn';

interface ContentCardShellProps {
  nodeRef: (node: HTMLElement | null) => void;
  style: CSSProperties;
  isDragging: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  loading: boolean;
  error: boolean;
  title: string | null;
  seq: number;
  topRight?: ReactNode;
  bottomRight?: ReactNode;
  titleMeta?: ReactNode;
  actions: ReactNode;
}

export function ContentCardShell({
  nodeRef,
  style,
  isDragging,
  canvasRef,
  loading,
  error,
  title,
  seq,
  topRight,
  bottomRight,
  titleMeta,
  actions,
}: ContentCardShellProps) {
  return (
    <div
      ref={nodeRef}
      style={style}
      className={cn('craft-card flex flex-col overflow-hidden', isDragging && 'opacity-90')}
    >
      <div className="aspect-[4/3] bg-cream relative overflow-hidden border-b border-ink">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner />
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center text-stone-light text-[12px]">
            加载失败
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            width={FRAME_WIDTH}
            height={FRAME_HEIGHT}
            className="block w-full h-full"
            style={{ imageRendering: 'pixelated' }}
          />
        )}

        <span className="absolute top-2 left-2 bg-paper border border-ink px-1.5 font-mono text-[10px] pointer-events-none">
          {String(seq).padStart(2, '0')}
        </span>

        {topRight}
        {bottomRight}
      </div>

      <div className="px-3.5 pt-2.5 pb-2 flex-1 min-w-0">
        <p
          className={cn(
            'font-serif text-[15px] truncate leading-snug',
            title ? 'text-ink' : 'text-stone-light italic'
          )}
        >
          {title ?? '未命名'}
        </p>
        {titleMeta}
      </div>

      <div className="px-2 py-2 border-t border-line flex items-center gap-0.5">{actions}</div>
    </div>
  );
}
