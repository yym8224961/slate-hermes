import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { clearCanvas, decodeBppImage, isValidBppLength } from '@/lib/eink/bpp';

export function useContentBitmap(data: ArrayBuffer | null | undefined) {
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
