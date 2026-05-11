// 帧预览 canvas — 三种来源:
//   1. 用户选了新图 → 跑 dither + threshold 渲染(与 server 同算法)
//   2. edit 模式且未传新图 → 直接画 server 上的 1bpp blob
//   3. create 模式且未传图 → 空 paper 底
//
// 拖拽 + 缩放交互内嵌(选了图后才生效)。

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  rgbaToGray,
  autoInvert,
  autoContrast,
  ditherToBinary,
} from 'shared';
import type { DitherMode } from 'shared';
import { StatusBarOverlay } from '../StatusBarOverlay';
import { cn } from '../../lib/cn';
import { PAPER_HEX, PAPER_RGB, INK_RGB } from '../../lib/colors';
import { decodeBppImage, isValidBppLength } from '../../lib/image';

interface PreviewCanvasProps {
  imageFile: File | null;
  existingImage: ArrayBuffer | undefined;
  threshold: number;
  mode: DitherMode;
  caption: string;
  showSafeArea: boolean;
  scale: number;
  offset: { x: number; y: number };
  onOffsetChange: (o: { x: number; y: number }) => void;
  /** 把 canvas ref 暴露给父级,用于提交时 toBlob */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

export function PreviewCanvas({
  imageFile,
  existingImage,
  threshold,
  mode,
  caption,
  showSafeArea,
  scale,
  offset,
  onOffsetChange,
  canvasRef,
}: PreviewCanvasProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(
    null
  );

  // 渲染逻辑:三个分支
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (imageFile) {
      const url = URL.createObjectURL(imageFile);
      let revoked = false;
      const revoke = () => {
        if (!revoked) {
          URL.revokeObjectURL(url);
          revoked = true;
        }
      };
      const img = new Image();
      img.onload = () => {
        ctx.fillStyle = PAPER_HEX;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const baseScale = Math.min(canvas.width / img.width, canvas.height / img.height);
        const finalScale = baseScale * scale;
        const drawW = img.width * finalScale;
        const drawH = img.height * finalScale;
        const drawX = (canvas.width - drawW) / 2 + offset.x;
        const drawY = (canvas.height - drawH) / 2 + offset.y;
        ctx.drawImage(img, drawX, drawY, drawW, drawH);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let gray = rgbaToGray(imageData.data, canvas.width, canvas.height, 4);
        gray = autoInvert(gray, canvas.width, canvas.height);
        gray = autoContrast(gray, 1);
        const bin = ditherToBinary(gray, canvas.width, canvas.height, { mode, threshold });

        for (let i = 0, j = 0; i < imageData.data.length; i += 4, j++) {
          const isWhite = bin[j] === 255;
          const c = isWhite ? PAPER_RGB : INK_RGB;
          imageData.data[i] = c[0];
          imageData.data[i + 1] = c[1];
          imageData.data[i + 2] = c[2];
          imageData.data[i + 3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);
        revoke();
      };
      img.onerror = revoke;
      img.src = url;
      return revoke;
    }

    if (existingImage) {
      const bytes = new Uint8Array(existingImage);
      if (!isValidBppLength(bytes)) return;
      const data = decodeBppImage(bytes);
      ctx.putImageData(data, 0, 0);
      return;
    }

    ctx.fillStyle = PAPER_HEX;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, [imageFile, existingImage, threshold, mode, scale, offset, canvasRef]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!imageFile) return;
      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        offsetX: offset.x,
        offsetY: offset.y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [imageFile, offset]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging || !dragStartRef.current) return;
      onOffsetChange({
        x: dragStartRef.current.offsetX + (e.clientX - dragStartRef.current.x),
        y: dragStartRef.current.offsetY + (e.clientY - dragStartRef.current.y),
      });
    },
    [isDragging, onOffsetChange]
  );

  const onPointerUp = useCallback(() => {
    setIsDragging(false);
    dragStartRef.current = null;
  }, []);

  return (
    <div className="bg-paper border border-ink p-1.5">
      <div className="relative overflow-hidden border border-line aspect-[4/3]">
        <canvas
          ref={canvasRef}
          width={FRAME_WIDTH}
          height={FRAME_HEIGHT}
          className={cn('block w-full h-full', isDragging && 'cursor-grabbing')}
          style={{
            imageRendering: 'pixelated',
            cursor: imageFile ? 'grab' : 'default',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <StatusBarOverlay caption={caption} showSafeArea={showSafeArea} />
      </div>
    </div>
  );
}
