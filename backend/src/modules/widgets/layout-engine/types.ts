/**
 * Widget JSON layout DSL —— 后端读 definitions/*.json 转换的内部表示。
 *
 * 设计原则：
 * - 严格 400×300 输出；根容器隐式是 vertical_stack。
 * - block 树结构尽量扁平，避免过度嵌套。
 * - field 用点号路径访问 LayoutCtx：`config.locationLabel` / `data.tempC` / `meta.lunarDate`。
 * - 字体只允许三种 family：serif / sans / mono（对应 Noto Serif SC / IBM Plex Sans / IBM Plex Mono）。
 * - 颜色只有 #000 / #fff —— 输出会经过 1bpp 阈值。
 */

export type FontFamily = 'serif' | 'sans' | 'mono';
export type TextAlign = 'left' | 'center' | 'right';

export interface CenteredTextBlock {
  block: 'centered_text';
  field: string;
  size: number;
  font?: FontFamily;
  weight?: 'normal' | 'bold';
}

export interface TextBlock {
  block: 'text';
  field: string;
  size: number;
  font?: FontFamily;
  align?: TextAlign;
  wrap?: boolean;
  max_lines?: number;
  weight?: 'normal' | 'bold';
}

export interface KeyValueItem {
  /** 静态标签文本（与 label_field 二选一）*/
  label?: string;
  /** 动态标签，从 LayoutCtx 取值的路径（与 label 二选一）*/
  label_field?: string;
  field: string;
  suffix?: string;
}

export interface KeyValueBlock {
  block: 'key_value';
  items: KeyValueItem[];
  size?: number;
  font?: FontFamily;
}

export interface BigNumberBlock {
  block: 'big_number';
  field: string;
  size: number;
  suffix?: string;
  align?: TextAlign;
  font?: FontFamily;
}

export interface SeparatorBlock {
  block: 'separator';
  style?: 'solid' | 'dashed';
}

export interface VerticalStackBlock {
  block: 'vertical_stack';
  body: Block[];
  gap?: number;
}

export type Block =
  | CenteredTextBlock
  | TextBlock
  | KeyValueBlock
  | BigNumberBlock
  | SeparatorBlock
  | VerticalStackBlock;

export interface WidgetLayout {
  size: [number, number]; // 当前固定 [400, 300]
  padding?: number; // 水平 + 底部内边距（px）
  top_offset?: number; // 顶部偏移，跳过设备状态栏（24px）
  body: Block[];
}

export interface WidgetDefinition {
  type: string;
  default_ttl_sec: number | null; // null = push-only（dashboard）
  layout: WidgetLayout;
}

/** 渲染上下文 —— field 路径的根。 */
export interface LayoutCtx {
  config: Record<string, unknown>;
  data: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/** block 渲染返回值。height 用于流式累加 Y 坐标。 */
export interface BlockRender {
  svg: string;
  height: number;
}
