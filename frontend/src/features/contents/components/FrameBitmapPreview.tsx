import { useRef } from 'react';
import { FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import { useContentBitmap } from './content-card/useContentBitmap';
import { cn } from '@/lib/cn';
import { StatusBarOverlay } from './StatusBarOverlay';

interface FrameBitmapPreviewProps {
  data?: ArrayBuffer | null;
  cacheKey?: string | null;
  caption?: string | null;
  className?: string;
  showStatusBar?: boolean;
  showSafeArea?: boolean;
}

export function FrameBitmapPreview({
  data,
  cacheKey,
  caption,
  className,
  showStatusBar = true,
  showSafeArea,
}: FrameBitmapPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useContentBitmap(canvasRef, data, cacheKey ?? null);

  return (
    <div className={cn('relative h-full w-full overflow-hidden bg-paper', className)}>
      <canvas
        ref={canvasRef}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        className="block h-full w-full"
        style={{ imageRendering: 'pixelated' }}
      />
      {showStatusBar && <StatusBarOverlay caption={caption} showSafeArea={showSafeArea} />}
    </div>
  );
}
