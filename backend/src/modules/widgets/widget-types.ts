import type { DynamicTypeT as SharedDynamicTypeT } from 'shared';
import type { WidgetDefinition, WidgetLayout, LayoutCtx } from './layout-engine/types';

export type DynamicTypeT = SharedDynamicTypeT;

/**
 * DataProvider —— 给定 config + ctx，拿到要展示的数据。
 *
 * 设计原则：
 * - provider 不负责渲染，只负责"这项动态内容此刻应该展示什么数据"。
 * - render 由 layout-engine 统一做。
 * - dashboard provider 的 fetchData 实际是读 Content.dynamicData（push 进来的最近 payload）。
 *
 * 失败处理：抛错 → renderer 写 dynamic_last_error 并使用占位 data 继续渲染；
 * 不应让 scheduler tick 整批挂掉。
 */
export interface DataProvider<C = unknown, D = unknown> {
  type: string;
  /**
   * 解析并校验 dynamic_config。raw 是 JSON（来自 Content.dynamicConfig）。
   * 失败抛 zod error。
   */
  validateConfig(raw: unknown): C;

  /**
   * 拉数据。ctx 含 now、dataOverride（dashboard push 时直接用 override）。
   * 返回值会落到 Content.dynamicData 缓存。
   */
  fetchData(config: C, ctx: WidgetFetchCtx): Promise<D>;
}

export interface WidgetFetchCtx {
  /** 当前时刻（测试可注入）。 */
  now: Date;
  /** dashboard 动态内容收到 push 时，可跳过 fetchData 用 override 直接渲染。 */
  dataOverride?: unknown;
  /** 上次落盘的 dynamicData，provider 可在失败时回退。 */
  lastData?: unknown;
}

/** WidgetRegistry 单元素：模板 + provider。type 由两边共同声明，要一致。 */
export interface WidgetEntry {
  type: string;
  definition: WidgetDefinition;
  provider: DataProvider;
}

/** 给 LayoutCtx 构造一个"meta"快照（如 lunar 日期、时段标签等），与 data 分开放。 */
export interface MetaBuilder {
  build(now: Date, config: Record<string, unknown>): Record<string, unknown>;
}

export type { WidgetDefinition, WidgetLayout, LayoutCtx };
