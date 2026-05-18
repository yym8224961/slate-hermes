import type { LayoutCtx } from './types';

/**
 * 用点号路径从 LayoutCtx 取值。
 *
 *   resolveField(ctx, 'data.tempC')           → 23
 *   resolveField(ctx, 'config.locationLabel') → '北京'
 *   resolveField(ctx, 'data.events.0.title')  → '...'  // 数组按下标
 *
 * 路径不存在或中间是 null/undefined → 返回 undefined（block 渲染器自己决定怎么降级）。
 */
export function resolveField(ctx: LayoutCtx, path: string): unknown {
  if (!path) return undefined;
  const segs = path.split('.');
  let cur: unknown = ctx;
  for (const seg of segs) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** field 取出后转字符串，缺失/null 转 ''。供文本 block 用。 */
export function resolveText(ctx: LayoutCtx, path: string): string {
  const v = resolveField(ctx, path);
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
