import { useEffect, type RefObject } from 'react';
import { decodeBppImage, isValidBppLength } from '../../lib/image';

const imageDataCache = new Map<string, ImageData>();
const MAX_CACHE_SIZE = 50;

function rememberImageData(etag: string, data: ImageData): void {
  imageDataCache.set(etag, data);
  if (imageDataCache.size <= MAX_CACHE_SIZE) return;
  const firstKey = imageDataCache.keys().next().value;
  if (firstKey) imageDataCache.delete(firstKey);
}

export function useContentBitmap(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  data: ArrayBuffer | undefined,
  etag: string | null | undefined
): void {
  useEffect(() => {
    if (!data || !etag || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const bytes = new Uint8Array(data);
    if (!isValidBppLength(bytes)) return;

    const cached = imageDataCache.get(etag);
    if (cached) {
      ctx.putImageData(cached, 0, 0);
      return;
    }

    const decoded = decodeBppImage(bytes);
    rememberImageData(etag, decoded);
    ctx.putImageData(decoded, 0, 0);
  }, [canvasRef, data, etag]);
}
