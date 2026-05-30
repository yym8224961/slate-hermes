import { FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import { useContentBitmap } from './useContentBitmap';
import { cn } from '@/lib/cn';
import { StatusBarOverlay } from './StatusBarOverlay';

interface FrameBitmapPreviewProps {
  data?: ArrayBuffer | null;
  caption?: string | null;
  className?: string;
  showStatusBar?: boolean;
  showSafeArea?: boolean;
}

export function FrameBitmapPreview({
  data,
  caption,
  className,
  showStatusBar = true,
  showSafeArea,
}: FrameBitmapPreviewProps) {
  const canvasRef = useContentBitmap(data);

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
