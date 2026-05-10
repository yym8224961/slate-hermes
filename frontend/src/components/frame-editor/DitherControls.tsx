// 抖动算法选择 + 阈值滑块(仅 threshold 模式显示)+ 缩放滑块(仅选了图时显示)。

import { DITHER_MODES, DITHER_INFO } from 'shared';
import type { DitherMode } from 'shared';
import { Select, SelectItem } from '../Select';

interface DitherControlsProps {
  mode: DitherMode;
  onModeChange: (m: DitherMode) => void;
  threshold: number;
  onThresholdChange: (n: number) => void;
  /** 只有选了图才显示 scale 滑块 */
  hasImage: boolean;
  scale: number;
  onScaleChange: (n: number) => void;
  onResetCrop: () => void;
}

export function DitherControls({
  mode,
  onModeChange,
  threshold,
  onThresholdChange,
  hasImage,
  scale,
  onScaleChange,
  onResetCrop,
}: DitherControlsProps) {
  return (
    <div className="space-y-5">
      {hasImage && (
        <div>
          <div className="flex items-baseline justify-between mb-2 ml-0.5">
            <p className="font-sans text-[13px] text-stone">缩放</p>
            <div className="flex items-center gap-2">
              <p className="font-mono text-[12px] text-ink tabular-nums">{scale.toFixed(1)}×</p>
              <button
                type="button"
                onClick={onResetCrop}
                className="font-sans text-[11px] text-stone border-b border-stone hover:border-ink hover:text-ink transition-colors"
              >
                重置
              </button>
            </div>
          </div>
          <input
            type="range"
            min="0.5"
            max="3"
            step="0.1"
            value={scale}
            onChange={(e) => onScaleChange(Number(e.target.value))}
          />
          <p className="font-serif italic text-[11px] text-stone-light mt-1.5">
            预览图可拖拽定位,滑块控制缩放。
          </p>
        </div>
      )}

      <div>
        <div className="flex items-baseline justify-between mb-2 ml-0.5">
          <p className="font-sans text-[13px] text-stone">抖动算法</p>
          <p className="font-mono text-[11px] text-stone-light">{DITHER_INFO[mode].hint}</p>
        </div>
        <Select
          value={mode}
          onValueChange={(v) => onModeChange(v as DitherMode)}
          aria-label="抖动算法"
        >
          {DITHER_MODES.map((m) => (
            <SelectItem key={m} value={m}>
              <span className="font-serif">{DITHER_INFO[m].label}</span>
            </SelectItem>
          ))}
        </Select>
        <p className="font-kai text-[11px] text-stone-light mt-1.5">
          线稿用「线稿 · 纯黑白」;照片用「照片 · 推荐」。
        </p>
      </div>

      {mode === 'threshold' && (
        <div>
          <div className="flex items-baseline justify-between mb-2 ml-0.5">
            <p className="font-sans text-[13px] text-stone">阈值</p>
            <p className="font-mono text-[12px] text-ink tabular-nums">
              {threshold}
              <span className="text-stone-light">/255</span>
            </p>
          </div>
          <input
            type="range"
            min="0"
            max="255"
            value={threshold}
            onChange={(e) => onThresholdChange(Number(e.target.value))}
          />
          <p className="font-serif italic text-[11px] text-stone-light mt-1.5">
            简笔画 128;带细灰边的图试 180+。
          </p>
        </div>
      )}
    </div>
  );
}
