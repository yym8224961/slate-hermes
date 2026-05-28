import { useCallback, useEffect, useRef } from 'react';
import { clearCanvas, decodeBppImage, isValidBppLength } from '@/lib/image';

// 400x300 RGBA ImageData 约 480KB；默认保留约 8MB，换取列表滚动/返回时少解码。
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

/** LRU cache: Map 按插入顺序迭代，get 时将条目移到末尾以更新访问顺序 */
const imageDataCache = new Map<string, ImageData>();
let imageDataCacheBytes = 0;

export function clearContentBitmapCache(): void {
  imageDataCache.clear();
  imageDataCacheBytes = 0;
}

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
  const existing = imageDataCache.get(etag);
  if (existing) {
    imageDataCache.delete(etag);
    imageDataCacheBytes -= imageDataByteLength(existing);
  }
  imageDataCache.set(etag, data);
  imageDataCacheBytes += imageDataByteLength(data);
  // 超出字节上限时批量驱逐最旧的条目；单张大图至少保留最新一张。
  while (imageDataCacheBytes > MAX_CACHE_BYTES && imageDataCache.size > 1) {
    const lruKey = imageDataCache.keys().next().value;
    if (lruKey === undefined) break;
    const lru = imageDataCache.get(lruKey);
    imageDataCache.delete(lruKey);
    if (lru) imageDataCacheBytes -= imageDataByteLength(lru);
  }
}

function imageDataByteLength(data: ImageData): number {
  return data.data.byteLength;
}

export function useContentBitmap(
  data: ArrayBuffer | null | undefined,
  etag: string | null | undefined
): (node: HTMLCanvasElement | null) => void {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dataRef = useRef(data);
  const etagRef = useRef(etag);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const data = dataRef.current;
    const etag = etagRef.current;
    if (!data) {
      clearCanvas(ctx);
      return;
    }

    const bytes = new Uint8Array(data);
    if (!isValidBppLength(bytes)) {
      clearCanvas(ctx);
      return;
    }

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
  }, []);

  useEffect(() => {
    dataRef.current = data;
    etagRef.current = etag;
    draw();
  }, [data, draw, etag]);

  return useCallback(
    (node: HTMLCanvasElement | null) => {
      canvasRef.current = node;
      if (node) draw();
    },
    [draw]
  );
}
