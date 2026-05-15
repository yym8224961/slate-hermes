import type { BlockRender, SeparatorBlock } from '../types';

export function renderSeparator(block: SeparatorBlock, containerWidth: number): BlockRender {
  const style = block.style ?? 'solid';
  const dasharray = style === 'dashed' ? ' stroke-dasharray="4 2"' : '';
  // 分隔线占 8px 高，自身横线在中间 → y=4
  const svg = `<line x1="0" y1="4" x2="${containerWidth}" y2="4" stroke="#000" stroke-width="1"${dasharray}/>`;
  return { svg, height: 8 };
}
