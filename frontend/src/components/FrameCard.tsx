// Mono Press 帧卡：1bpp 缩略图 + caption + 操作行，0 圆角 ink 边框。

import { useEffect, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Pencil, Trash2, GripVertical } from 'lucide-react';
import { useFrameImage, useDeleteFrame } from '../lib/queries';
import type { FrameSummaryT } from 'shared';
import { Spinner } from './Spinner';
import { AudioPlayPreview } from './AudioPlayPreview';
import { useConfirm } from './Confirm';
import { useToast } from './Toast';
import { cn } from '../lib/cn';

interface FrameCardProps {
  gid: string;
  frame: FrameSummaryT;
  onEdit: () => void;
}

const FRAME_W = 400;
const FRAME_H = 300;

// Mono Press 墨色 #14110d + 纸本 #f5f3ed
const C_WHITE: [number, number, number] = [0xf5, 0xf3, 0xed];
const C_BLACK: [number, number, number] = [0x14, 0x11, 0x0d];

const imageDataCache = new Map<string, ImageData>();
const MAX_CACHE_SIZE = 50;

function buildFrameImageData(bytes: Uint8Array): ImageData {
  const data = new ImageData(FRAME_W, FRAME_H);
  const bpr = FRAME_W >> 3;
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      const byteIdx = y * bpr + (x >> 3);
      const bit = (bytes[byteIdx]! >> (7 - (x & 7))) & 1;
      const i = (y * FRAME_W + x) * 4;
      const c = bit ? C_WHITE : C_BLACK;
      data.data[i] = c[0];
      data.data[i + 1] = c[1];
      data.data[i + 2] = c[2];
      data.data[i + 3] = 255;
    }
  }
  return data;
}

export function FrameCard({ gid, frame, onEdit }: FrameCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const img = useFrameImage(gid, frame.sort_order, frame.image_etag);
  const del = useDeleteFrame(gid);
  const confirm = useConfirm();
  const toast = useToast();

  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: frame.image_etag,
    animateLayoutChanges: () => false,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: 'none',
    zIndex: isDragging ? 10 : undefined,
  };

  useEffect(() => {
    if (!img.data || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    const bytes = new Uint8Array(img.data);
    if (bytes.byteLength !== (FRAME_W * FRAME_H) / 8) return;

    let data = imageDataCache.get(frame.image_etag);
    if (!data) {
      data = buildFrameImageData(bytes);
      imageDataCache.set(frame.image_etag, data);
      if (imageDataCache.size > MAX_CACHE_SIZE) {
        const firstKey = imageDataCache.keys().next().value;
        if (firstKey) imageDataCache.delete(firstKey);
      }
    }
    ctx.putImageData(data, 0, 0);
  }, [img.data, frame.image_etag]);

  async function onDelete() {
    const ok = await confirm({
      title: `删除第 ${frame.sort_order} 帧？`,
      description: frame.caption
        ? `「${frame.caption}」连同图${frame.audio_etag ? '与音频' : ''}一起删除，不可逆。`
        : `这帧的图${frame.audio_etag ? '与音频' : ''}会删除，不可逆。`,
      destructive: true,
      confirmText: '删除',
    });
    if (!ok) return;
    del.mutate(frame.sort_order, {
      onSuccess: () => toast.success('已删除'),
      onError: () => toast.error('删除失败'),
    });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('craft-card flex flex-col overflow-hidden', isDragging && 'opacity-90')}
    >
      {/* 缩略图 */}
      <div className="aspect-[4/3] bg-cream relative overflow-hidden border-b border-ink">
        {img.isPending ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner />
          </div>
        ) : img.error ? (
          <div className="absolute inset-0 flex items-center justify-center text-stone-light text-[12px]">
            加载失败
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            width={FRAME_W}
            height={FRAME_H}
            className="block w-full h-full"
            style={{ imageRendering: 'pixelated' }}
          />
        )}

        {/* idx 角标 */}
        <span className="absolute top-2 left-2 bg-paper border border-ink px-1.5 font-mono text-[10px] pointer-events-none">
          {String(frame.sort_order).padStart(2, '0')}
        </span>

        {frame.audio_etag && (
          <span className="absolute top-2 right-2 bg-paper border border-ink text-ink px-1.5 font-mono text-[10px] pointer-events-none">
            ♪
          </span>
        )}
      </div>

      {/* caption */}
      <div className="px-3.5 pt-2.5 pb-2 flex-1 min-w-0">
        <p
          className={cn(
            'font-serif text-[15px] truncate leading-snug',
            frame.caption ? 'text-ink' : 'text-stone-light italic'
          )}
        >
          {frame.caption ?? '未命名'}
        </p>
      </div>

      {/* 操作行 */}
      <div className="px-2 py-1.5 border-t border-line flex items-center gap-0.5">
        <button
          {...attributes}
          {...listeners}
          aria-label="拖拽排序"
          title="拖拽排序"
          className="p-1.5 text-stone-light hover:text-ink hover:bg-cream transition-colors cursor-grab active:cursor-grabbing touch-none"
        >
          <GripVertical size={14} />
        </button>

        {frame.audio_etag && (
          <AudioPlayPreview gid={gid} idx={frame.sort_order} etag={frame.audio_etag} />
        )}

        <span className="flex-1" />

        <button
          onClick={onEdit}
          aria-label="编辑"
          title="编辑"
          className="p-1.5 text-stone hover:text-ink hover:bg-cream transition-colors"
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={onDelete}
          aria-label="删除"
          title="删除"
          className="p-1.5 text-stone hover:text-clay hover:bg-cream transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
