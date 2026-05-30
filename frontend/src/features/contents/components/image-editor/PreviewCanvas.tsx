// 帧预览 canvas — 三种来源：
//   1. 用户选了新图 → 跑 dither + threshold 渲染(与 server 同算法)
//   2. edit 模式且未传新图 → 直接画 server 上的 1bpp blob
//   3. create 模式且未传图 → 空 paper 底
//
// 拖拽 + 缩放交互内嵌(选了图后才生效)。

import { useCallback, useEffect, useRef, useState } from 'react';
import { FRAME_WIDTH, FRAME_HEIGHT } from 'shared';
import type { DitherMode } from 'shared';
import { cn } from '@/lib/cn';
import { clearCanvas, decodeBppImage, isValidBppLength } from '@/lib/frame/bpp';
import { drawImagePreview } from '@/lib/frame/image-preview';
import { StatusBarOverlay } from '../preview/StatusBarOverlay';

interface PreviewCanvasProps {
  imageFile: File | null;
  existingImage: ArrayBuffer | undefined;
  /** edit 模式下原图加载中的状态 */
  existingImagePending?: boolean;
  threshold: number;
  mode: DitherMode;
  scale: number;
  offset: { x: number; y: number };
  onOffsetChange: (o: { x: number; y: number }) => void;
  /** 把 canvas ref 暴露给父级,用于提交时 toBlob */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  statusCaption?: string | null;
  showStatusBar?: boolean;
  showSafeArea?: boolean;
}

export function PreviewCanvas({
  imageFile,
  existingImage,
  existingImagePending,
  threshold,
  mode,
  scale,
  offset,
  onOffsetChange,
  canvasRef,
  statusCaption,
  showStatusBar = true,
  showSafeArea = false,
}: PreviewCanvasProps) {
  const [loadedImage, setLoadedImage] = useState<{
    file: File;
    image: HTMLImageElement;
  } | null>(null);
  const drawFrameRef = useRef<number | null>(null);
  const currentOffsetRef = useRef(offset);

  const cancelScheduledDraw = useCallback(() => {
    if (drawFrameRef.current == null) return;
    cancelAnimationFrame(drawFrameRef.current);
    drawFrameRef.current = null;
  }, []);

  useEffect(() => {
    if (!imageFile) {
      setLoadedImage(null);
      return;
    }

    const url = URL.createObjectURL(imageFile);
    let cancelled = false;
    let revoked = false;
    const revoke = () => {
      if (!revoked) {
        URL.revokeObjectURL(url);
        revoked = true;
      }
    };
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setLoadedImage({ file: imageFile, image: img });
      revoke();
    };
    img.onerror = () => {
      if (!cancelled) setLoadedImage(null);
      revoke();
    };
    img.src = url;
    return () => {
      cancelled = true;
      revoke();
    };
  }, [imageFile]);

  useEffect(() => cancelScheduledDraw, [cancelScheduledDraw]);

  const drawLoadedImage = useCallback(
    (dither: boolean) => {
      if (!imageFile || loadedImage?.file !== imageFile) return false;
      const canvas = canvasRef.current;
      if (!canvas) return false;
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      drawImagePreview(ctx, canvas, loadedImage.image, {
        scale,
        offset: currentOffsetRef.current,
        threshold,
        mode,
        dither,
      });
      return true;
    },
    [canvasRef, imageFile, loadedImage, mode, scale, threshold]
  );

  const scheduleImageDraw = useCallback(
    (dither: boolean) => {
      cancelScheduledDraw();
      drawFrameRef.current = requestAnimationFrame(() => {
        drawFrameRef.current = null;
        drawLoadedImage(dither);
      });
    },
    [cancelScheduledDraw, drawLoadedImage]
  );

  const pan = useCanvasPan({
    enabled: !!imageFile && loadedImage?.file === imageFile,
    offset,
    currentOffsetRef,
    onOffsetChange,
    onPreviewMove: () => scheduleImageDraw(false),
    onCommit: () => scheduleImageDraw(true),
  });
  const { isDraggingRef } = pan;

  // 渲染逻辑：三个分支。新图只在文件变化时加载；拖拽中只重画已加载图片，
  // 指针松开后再跑灰度预处理 + dither，避免每帧重复解码和抖动。
  // 拖拽期间 props.offset 不变（实时位置走 dragOffsetRef），所以这里依赖 offset
  // 不会引起每帧 effect 重跑；只有拖拽结束 onOffsetChange 回传或外部 reset 时才触发。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (imageFile) {
      if (loadedImage?.file !== imageFile) {
        cancelScheduledDraw();
        clearCanvas(ctx, canvas);
        return;
      }
      if (!isDraggingRef.current) {
        currentOffsetRef.current = offset;
      }
      scheduleImageDraw(!isDraggingRef.current);
      return cancelScheduledDraw;
    }

    cancelScheduledDraw();
    if (existingImage) {
      const bytes = new Uint8Array(existingImage);
      if (!isValidBppLength(bytes)) {
        clearCanvas(ctx, canvas);
        return;
      }
      const data = decodeBppImage(bytes);
      ctx.putImageData(data, 0, 0);
      return;
    }

    clearCanvas(ctx, canvas);
  }, [
    canvasRef,
    cancelScheduledDraw,
    imageFile,
    existingImage,
    loadedImage,
    offset,
    isDraggingRef,
    scheduleImageDraw,
  ]);

  return (
    <div className="bg-paper border border-ink relative overflow-hidden aspect-[4/3]">
      {existingImagePending && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="font-serif italic text-[13px] text-stone-light">加载中…</span>
        </div>
      )}
      {!imageFile && !existingImage && !existingImagePending && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="font-serif italic text-[13px] text-stone-light">选图后显示预览</span>
        </div>
      )}
      {imageFile && (
        <div className="absolute inset-0 flex items-end justify-center pb-3 pointer-events-none">
          <span className="font-serif italic text-[13px] text-stone-light">
            拖拽定位 · 滑块缩放
          </span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        className={cn('block w-full h-full', pan.isDragging && 'cursor-grabbing')}
        style={{
          imageRendering: 'auto',
          cursor: imageFile ? 'grab' : 'default',
        }}
        onPointerDown={pan.onPointerDown}
        onPointerMove={pan.onPointerMove}
        onPointerUp={pan.onPointerUp}
        onPointerCancel={pan.onPointerUp}
      />
      {showStatusBar && <StatusBarOverlay caption={statusCaption} showSafeArea={showSafeArea} />}
    </div>
  );
}

function useCanvasPan({
  enabled,
  offset,
  currentOffsetRef,
  onOffsetChange,
  onPreviewMove,
  onCommit,
}: {
  enabled: boolean;
  offset: { x: number; y: number };
  currentOffsetRef: React.MutableRefObject<{ x: number; y: number }>;
  onOffsetChange: (o: { x: number; y: number }) => void;
  onPreviewMove: () => void;
  onCommit: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(
    null
  );

  useEffect(() => {
    if (!isDraggingRef.current) currentOffsetRef.current = offset;
  }, [currentOffsetRef, offset]);

  useEffect(() => {
    if (enabled) return;
    isDraggingRef.current = false;
    setIsDragging(false);
    dragStartRef.current = null;
    currentOffsetRef.current = offset;
  }, [currentOffsetRef, enabled, offset]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      isDraggingRef.current = true;
      setIsDragging(true);
      currentOffsetRef.current = offset;
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        offsetX: offset.x,
        offsetY: offset.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [currentOffsetRef, enabled, offset]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDraggingRef.current || !dragStartRef.current) return;
      currentOffsetRef.current = {
        x: dragStartRef.current.offsetX + (e.clientX - dragStartRef.current.x),
        y: dragStartRef.current.offsetY + (e.clientY - dragStartRef.current.y),
      };
      onPreviewMove();
    },
    [currentOffsetRef, onPreviewMove]
  );

  const onPointerUp = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);
    dragStartRef.current = null;
    onOffsetChange(currentOffsetRef.current);
    onCommit();
  }, [currentOffsetRef, onCommit, onOffsetChange]);

  return {
    isDragging,
    isDraggingRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
