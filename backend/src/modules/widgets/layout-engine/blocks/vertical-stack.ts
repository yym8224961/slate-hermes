import type { Block, BlockRender, LayoutCtx, VerticalStackBlock } from '../types';
import { renderBlock } from '../engine';

/**
 * 流式从上往下排版子 block，按返回 height 累加 Y。
 * gap 默认 8px，相邻 block 之间留白。
 * 根容器（隐式 vertical_stack）由 engine.ts 直接处理，这里支持嵌套。
 */
export function renderVerticalStack(
  block: VerticalStackBlock,
  ctx: LayoutCtx,
  containerWidth: number
): BlockRender {
  const gap = block.gap ?? 8;
  const pieces: string[] = [];
  let y = 0;
  for (const child of block.body) {
    const rendered = renderBlock(child as Block, ctx, containerWidth);
    if (rendered.height === 0) continue;
    pieces.push(`<g transform="translate(0,${y})">${rendered.svg}</g>`);
    y += rendered.height + gap;
  }
  // 移除最后一个 gap
  if (y > 0) y -= gap;
  return { svg: pieces.join(''), height: y };
}
