import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import { cn } from '@/lib/cn';
import { clearCanvas, decodeBppImage, isValidBppLength } from '@/lib/eink/bpp';
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

function useContentBitmap(data: ArrayBuffer | null | undefined) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageData = useMemo(() => decodeContentBitmap(data), [data]);

  useLayoutEffect(() => {
    drawContentBitmap(canvasRef.current, imageData);
  }, [imageData]);

  return useCallback((node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
  }, []);
}

function drawContentBitmap(canvas: HTMLCanvasElement | null, data: ImageData | null): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!data) {
    clearCanvas(ctx);
    return;
  }

  ctx.putImageData(data, 0, 0);
}

function decodeContentBitmap(data: ArrayBuffer | null | undefined): ImageData | null {
  if (!data) return null;
  const bytes = new Uint8Array(data);
  if (!isValidBppLength(bytes)) return null;
  return decodeBppImage(bytes);
}
