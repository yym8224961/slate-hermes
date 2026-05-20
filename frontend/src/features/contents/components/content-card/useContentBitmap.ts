import { useEffect, type RefObject } from 'react';
import { decodeBppImage, isValidBppLength } from '@/lib/image';

const MAX_CACHE_SIZE = 32;

/** LRU cache: Map 按插入顺序迭代，get 时将条目移到末尾以更新访问顺序 */
const imageDataCache = new Map<string, ImageData>();

function getCachedImageData(etag: string): ImageData | undefined {
  const entry = imageDataCache.get(etag);
  if (entry === undefined) return undefined;
  // 将命中的条目移到末尾，使其成为最近使用
  imageDataCache.delete(etag);
  imageDataCache.set(etag, entry);
  return entry;
}

function rememberImageData(etag: string, data: ImageData): void {
  // 若 etag 已存在，先删除再插入以更新顺序
  if (imageDataCache.has(etag)) imageDataCache.delete(etag);
  imageDataCache.set(etag, data);
  // 超出容量时批量驱逐最旧的条目，保留 MAX_CACHE_SIZE 个
  while (imageDataCache.size > MAX_CACHE_SIZE) {
    const lruKey = imageDataCache.keys().next().value;
    if (lruKey === undefined) break;
    imageDataCache.delete(lruKey);
  }
}

export function useContentBitmap(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  data: ArrayBuffer | undefined,
  etag: string | null | undefined
): void {
  useEffect(() => {
    if (!data || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const bytes = new Uint8Array(data);
    if (!isValidBppLength(bytes)) return;

    if (etag) {
      const cached = getCachedImageData(etag);
      if (cached) {
        ctx.putImageData(cached, 0, 0);
        return;
      }
    }

    const decoded = decodeBppImage(bytes);
    if (etag) rememberImageData(etag, decoded);
    ctx.putImageData(decoded, 0, 0);
  }, [canvasRef, data, etag]);
}
