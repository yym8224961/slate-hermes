import { FRAME_WIDTH } from 'shared';
import { BitmapCanvas, PIXEL_BLACK, PIXEL_WHITE } from './bitmap-canvas';
import type { DynamicRenderContext } from './dynamic-render-context';
import { type FrameDrawKit } from './frame-draw-kit';
import {
  CONTENT_LEFT,
  CONTENT_RIGHT,
  CONTENT_WIDTH,
  FALLBACK_TEXT,
  STATUS_BAR_H,
} from './frame-renderer-layout';
import type { FontSet } from './fonts/dynamic-frame-font.service';
import { isRecord, pickText, readInt } from './helpers/frame-value-utils';

const HOT_LIST_RENDER_COUNT = 8;

export function renderHotListFrame(
  c: BitmapCanvas,
  fonts: FontSet,
  ctx: DynamicRenderContext,
  draw: FrameDrawKit
): void {
  const data = ctx.data ?? {};
  const rawItems = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
  const items = rawItems.slice(0, HOT_LIST_RENDER_COUNT);
  const listTop = STATUS_BAR_H + 10;
  const rowH = 33;
  const rankBoxW = 28;
  const rankBoxH = 18;
  const rankX = CONTENT_LEFT;
  const titleX = CONTENT_LEFT + 42;
  const titleW = CONTENT_RIGHT - titleX;

  if (items.length === 0) {
    draw.drawText(c, fonts.sans16, '暂无榜单数据', FRAME_WIDTH / 2, 136, {
      align: 'center',
      maxWidth: CONTENT_WIDTH,
    });
    return;
  }

  items.forEach((item, index) => {
    const y = listTop + index * rowH;
    const rowCenterY = y + (rowH - 2) / 2;
    const rankY = Math.round(rowCenterY - rankBoxH / 2);
    const rank = readInt(item.rank, index + 1, 1, 99);
    const title = pickText(item.title, FALLBACK_TEXT);
    const topRank = index < 3;

    if (topRank) c.fillRect(rankX, rankY, rankBoxW, rankBoxH, PIXEL_BLACK);
    else c.strokeRect(rankX, rankY, rankBoxW, rankBoxH, PIXEL_BLACK);
    draw.drawTextInBox(
      c,
      fonts.metric12,
      String(rank).padStart(2, '0'),
      rankX,
      rankY,
      rankBoxW,
      rankBoxH,
      topRank ? PIXEL_WHITE : PIXEL_BLACK
    );
    draw.drawTextCenteredY(c, fonts.sans16, title, titleX, rowCenterY, {
      maxWidth: titleW,
      ellipsis: true,
    });

    if (index < items.length - 1) {
      draw.drawRule(c, CONTENT_LEFT, y + rowH - 1, CONTENT_WIDTH, 'dashed');
    }
  });
}
