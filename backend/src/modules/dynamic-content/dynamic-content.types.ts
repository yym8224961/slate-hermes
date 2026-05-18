import type { DynamicTypeT as SharedDynamicTypeT } from 'shared';
import type {
  DynamicContentDefinition,
  DynamicContentLayout,
  LayoutCtx,
} from './layout-engine/types';

export type DynamicTypeT = SharedDynamicTypeT;

/**
 * DataProvider —— 给定 config + ctx，拿到要展示的数据。
 *
 * 设计原则：
 * - provider 不负责渲染，只负责"这项动态内容此刻应该展示什么数据"。
 * - render 由服务端统一生成 400x300 1bpp image，设备端只负责显示。
 * - dashboard provider 的 fetchData 实际是读上次 push 进来的最近 payload。
 *
 * 失败处理：抛错 → refresh service 保留上次已落库数据，不更新 manifest。
 */
export interface DataProvider<C = unknown, D = unknown> {
  type: string;
  /**
   * 解析并校验 config。raw 是 JSON（来自 Content.config）。
   * 失败抛 zod error。
   */
  validateConfig(raw: unknown): C;

  /**
   * 拉数据。dashboard push 的 dataOverride 由 renderer 层直接短路处理。
   * 返回值会落到 Content.dynamicData 缓存。
   */
  fetchData(config: C, ctx: DynamicContentFetchCtx): Promise<D>;
}

export interface DynamicContentFetchCtx {
  /** 当前时刻（测试可注入）。 */
  now: Date;
  /** 上次落盘的 dynamicData，provider 可在失败时回退。 */
  lastData?: unknown;
}

/** DynamicContentRegistry 单元素：模板 + provider。type 由两边共同声明，要一致。 */
export interface DynamicContentEntry {
  type: string;
  definition: DynamicContentDefinition;
  provider: DataProvider;
}

/** 给 LayoutCtx 构造一个"meta"快照（如 lunar 日期、时段标签等），与 data 分开放。 */
export interface MetaBuilder {
  build(now: Date, config: Record<string, unknown>): Record<string, unknown>;
}

export type { DynamicContentDefinition, DynamicContentLayout, LayoutCtx };
