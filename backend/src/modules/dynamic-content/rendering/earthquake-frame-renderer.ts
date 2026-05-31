import { FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import { timezoneFromConfig } from '../timezone';
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
import { textWidth } from './fonts/bitmap-font';
import type { FontSet } from './fonts/dynamic-frame-font.service';
import { earthquakeFields } from './helpers/earthquake-render-utils';
import { formatShortTime } from './helpers/frame-date-utils';
import { isRecord, pickText } from './helpers/frame-value-utils';

export function renderEarthquakeReportFrame(
  c: BitmapCanvas,
  fonts: FontSet,
  ctx: DynamicRenderContext,
  draw: FrameDrawKit
): void {
  const data = ctx.data ?? {};
  const rawItems = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
  const items = rawItems.slice(0, 4);
  const tz = timezoneFromConfig(ctx.config);
  const updatedAt = formatShortTime(data.updatedAt, ctx.renderedAt, tz);

  if (items.length === 0) {
    if (updatedAt) {
      draw.drawText(c, fonts.sans12, `更新 ${updatedAt}`, CONTENT_RIGHT, STATUS_BAR_H + 12, {
        align: 'right',
        maxWidth: 116,
        ellipsis: true,
      });
    }
    draw.drawText(c, fonts.sans16, '暂无地震速报', FRAME_WIDTH / 2, 146, {
      align: 'center',
      maxWidth: CONTENT_WIDTH,
    });
    return;
  }

  const latest = items[0]!;
  const heroY = STATUS_BAR_H + 10;
  const heroH = 106;
  const magW = 120;
  const magText = pickText(latest.magnitude, '--');
  const location = pickText(latest.location, FALLBACK_TEXT);
  const fields = earthquakeFields(latest);

  c.fillRect(CONTENT_LEFT, heroY, magW, heroH, PIXEL_BLACK);
  draw.drawText(c, fonts.sans12, '震级', CONTENT_LEFT + 8, heroY + 8, {
    maxWidth: magW - 16,
    ellipsis: true,
    color: PIXEL_WHITE,
  });
  drawMagnitudeValue(c, fonts, magText, CONTENT_LEFT + 4, heroY + 22, magW - 8, 58, draw);
  draw.drawText(
    c,
    fonts.sans12,
    updatedAt ? `更新 ${updatedAt}` : '最新速报',
    CONTENT_LEFT + 8,
    heroY + 82,
    {
      maxWidth: magW - 16,
      ellipsis: true,
      color: PIXEL_WHITE,
    }
  );

  const heroTextX = CONTENT_LEFT + magW + 14;
  const heroTextW = CONTENT_RIGHT - heroTextX;
  const locationH = draw.drawStrongText(c, fonts.sans16, location, heroTextX, heroY + 4, {
    maxWidth: heroTextW,
    maxLines: 2,
    ellipsis: true,
    lineGap: 2,
  });
  const fieldY = heroY + Math.max(34, locationH + 8);
  drawFieldPair(c, fonts, '时间', fields.time || '--', heroTextX, fieldY, heroTextW, draw);
  drawFieldPair(c, fonts, '深度', fields.depth, heroTextX, fieldY + 21, heroTextW, draw);
  drawFieldPair(c, fonts, '坐标', fields.coords || '--', heroTextX, fieldY + 42, heroTextW, draw);

  const rest = items.slice(1);
  if (rest.length === 0) return;

  const startY = heroY + heroH + 12;
  const rowH = Math.min(46, Math.floor((FRAME_HEIGHT - startY - 8) / rest.length));
  rest.forEach((item, index) => {
    const y = startY + index * rowH;
    const titleY = y + 5;
    const detailY = y + 26;
    const magnitude = pickText(item.magnitude, '--');
    const location = pickText(item.location, FALLBACK_TEXT);
    const fields = earthquakeFields(item);

    draw.drawBadge(c, fonts, `M${magnitude}`, CONTENT_LEFT, y + 11, 52, 24, index === 0);
    draw.drawText(c, fonts.sans16, location, CONTENT_LEFT + 66, titleY, {
      maxWidth: CONTENT_RIGHT - CONTENT_LEFT - 66,
      maxLines: 1,
      ellipsis: true,
    });
    if (fields.time) {
      draw.drawText(c, fonts.metric12, fields.time, CONTENT_LEFT + 66, detailY, {
        maxWidth: 62,
        ellipsis: true,
      });
    }
    draw.drawText(c, fonts.metric12, fields.depth, CONTENT_LEFT + 138, detailY, {
      maxWidth: CONTENT_RIGHT - CONTENT_LEFT - 138,
      ellipsis: true,
    });
    if (index < rest.length - 1) {
      draw.drawRule(
        c,
        CONTENT_LEFT + 66,
        y + rowH - 1,
        CONTENT_RIGHT - CONTENT_LEFT - 66,
        'dashed'
      );
    }
  });
}

function drawFieldPair(
  c: BitmapCanvas,
  fonts: FontSet,
  label: string,
  value: string,
  x: number,
  y: number,
  w: number,
  draw: FrameDrawKit
): void {
  const labelW = 38;
  draw.drawText(c, fonts.sans16, label, x, y, {
    maxWidth: labelW,
    ellipsis: true,
  });
  draw.drawText(c, fonts.sans16, value, x + labelW + 8, y, {
    maxWidth: w - labelW - 8,
    ellipsis: true,
  });
}

function drawMagnitudeValue(
  c: BitmapCanvas,
  fonts: FontSet,
  value: string,
  x: number,
  y: number,
  w: number,
  h: number,
  draw: FrameDrawKit
): void {
  const compact = value.match(/^(\d+)\.(\d)$/);
  if (compact) {
    const digitW = 42;
    const centerX = x + Math.round(w / 2);
    draw.drawTextInBox(
      c,
      fonts.displayLarge,
      compact[1]!,
      centerX - digitW - 7,
      y,
      digitW,
      h,
      PIXEL_WHITE
    );
    draw.drawTextInBox(c, fonts.displayLarge, compact[2]!, centerX + 7, y, digitW, h, PIXEL_WHITE);
    c.fillRect(centerX - 3, y + h - 20, 7, 7, PIXEL_WHITE);
    return;
  }

  const font = textWidth(fonts.displayLarge, value) <= w - 4 ? fonts.displayLarge : fonts.sans16;
  draw.drawTextInBox(c, font, value, x, y, w, h, PIXEL_WHITE);
}
