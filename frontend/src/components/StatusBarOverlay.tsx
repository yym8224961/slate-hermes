// 模拟设备端状态栏 overlay，叠在 frame 预览顶部。
//
// 设备实际渲染规则:Frame 是 400×300,设备会在顶部叠加 24px 白底状态栏
// (左 WiFi 图标 / 中 caption / 右电量图标)。这层 overlay 1:1 显示给作者看,
// 上传时就能预判主体会不会被盖住。
//
// 8% 高 = 24/300 frame 高度比例。容器要 relative + overflow-hidden,
// 自身 absolute top/left/right。pointer-events-none 不拦截下方点击。

import { Wifi, BatteryFull } from 'lucide-react';
import { cn } from '../lib/cn';

interface StatusBarOverlayProps {
  caption?: string | null;
  className?: string;
  /** 编辑模式可打开:加红色虚线提示"安全区,主体别放这里" */
  showSafeArea?: boolean;
}

const STATUS_BAR_HEIGHT_PCT = (24 / 300) * 100; // 8%

export function StatusBarOverlay({ caption, className, showSafeArea }: StatusBarOverlayProps) {
  return (
    <>
      <div
        className={cn(
          'absolute top-0 left-0 right-0 flex items-center justify-between gap-2 px-[2%] bg-paper/90 border-b border-ink/30 pointer-events-none',
          className
        )}
        style={{ height: `${STATUS_BAR_HEIGHT_PCT}%` }}
        aria-hidden="true"
      >
        <Wifi size={14} className="text-ink shrink-0" />
        <span className="font-kai text-ink truncate text-[10px] sm:text-[11px] md:text-[12px] flex-1 text-center">
          {caption || ' '}
        </span>
        <BatteryFull size={14} className="text-ink shrink-0" />
      </div>
      {showSafeArea && (
        <div
          className="absolute top-0 left-0 right-0 border-2 border-dashed border-clay/70 pointer-events-none rounded-tl-[12px] rounded-tr-[12px]"
          style={{ height: `${STATUS_BAR_HEIGHT_PCT}%` }}
          aria-hidden="true"
        />
      )}
    </>
  );
}
