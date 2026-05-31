import { FRAME_HEIGHT, FRAME_WIDTH } from 'shared';

export interface TextOptions {
  align?: 'left' | 'center' | 'right';
  maxWidth?: number;
  maxLines?: number;
  ellipsis?: boolean;
  lineGap?: number;
  color?: number;
}

export const STATUS_BAR_H = 24;
export const CONTENT_SAFE_TOP = STATUS_BAR_H;
export const CONTENT_SAFE_BOTTOM = FRAME_HEIGHT;
export const CONTENT_LEFT = 20;
export const CONTENT_RIGHT = FRAME_WIDTH - 20;
export const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
export const FALLBACK_TEXT = '暂无数据';
