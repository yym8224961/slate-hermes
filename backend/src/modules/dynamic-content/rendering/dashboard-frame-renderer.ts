import { FRAME_HEIGHT, FRAME_WIDTH, type DashboardTemplateT } from 'shared';
import { BitmapCanvas, PIXEL_BLACK, PIXEL_WHITE } from './bitmap-canvas';
import {
  blockRect,
  resolveDashboardRenderInput,
  resolvePercentage,
  resolveSeries,
  resolveTemplate,
} from './dashboard-template';
import type { DynamicRenderContext } from './dynamic-render-context';
import { type FrameDrawKit } from './frame-draw-kit';
import { CONTENT_SAFE_BOTTOM, CONTENT_SAFE_TOP, CONTENT_WIDTH } from './frame-renderer-layout';
import { type FontSet } from './fonts/dynamic-frame-font.service';
import { readAlign, readInt, pickText } from './helpers/frame-value-utils';
import { textWidthFallback } from './frame-text-layout';

export function renderDashboardFrame(
  c: BitmapCanvas,
  fonts: FontSet,
  ctx: DynamicRenderContext,
  draw: FrameDrawKit
): void {
  const resolved = resolveDashboardRenderInput(ctx);
  if (!resolved) {
    const centerY = Math.round((CONTENT_SAFE_TOP + CONTENT_SAFE_BOTTOM) / 2);
    draw.drawText(c, fonts.sans16, '等待外部数据', FRAME_WIDTH / 2, centerY - 20, {
      align: 'center',
      maxWidth: CONTENT_WIDTH,
    });
    draw.drawText(
      c,
      fonts.sans12,
      'POST /api/v1/contents/:id/data',
      FRAME_WIDTH / 2,
      centerY + 12,
      {
        align: 'center',
        maxWidth: CONTENT_WIDTH,
      }
    );
    return;
  }

  renderDashboardTemplate(c, fonts, resolved.template, resolved.data, draw);
}

function renderDashboardTemplate(
  c: BitmapCanvas,
  fonts: FontSet,
  template: DashboardTemplateT,
  dataRoot: Record<string, unknown>,
  draw: FrameDrawKit
): void {
  for (const rawBlock of template.blocks) {
    if (!isBlockVisible(rawBlock.visible, dataRoot)) continue;
    const type = rawBlock.type;
    if (type === 'text') {
      const rect = blockRect(rawBlock);
      if (!rect) continue;
      const font =
        rawBlock.font_size === 12
          ? fonts.sans12
          : rawBlock.font_size === 32
            ? fonts.metric32
            : rawBlock.font_size === 48
              ? fonts.metric48
              : fonts.sans16;
      const color = rawBlock.color === 'white' ? PIXEL_WHITE : PIXEL_BLACK;
      const align = readAlign(rawBlock.align);
      const text = resolveTemplate(pickText(rawBlock.value, ''), dataRoot);
      const anchorX =
        align === 'center'
          ? rect.x + Math.round(rect.w / 2)
          : align === 'right'
            ? rect.x + rect.w
            : rect.x;
      draw.drawText(c, font, text, anchorX, rect.y, {
        align,
        maxWidth: rect.w,
        maxLines: readInt(rawBlock.max_lines, 1, 1, 4),
        ellipsis: rawBlock.ellipsis,
        color,
      });
    } else if (type === 'metric') {
      const rect = blockRect(rawBlock);
      if (!rect) continue;
      drawMetricBlock(
        c,
        fonts,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        resolveTemplate(pickText(rawBlock.label, ''), dataRoot),
        resolveTemplate(pickText(rawBlock.value, ''), dataRoot),
        resolveSeries(rawBlock.sparkline, dataRoot),
        draw
      );
    } else if (type === 'progress') {
      const rect = blockRect(rawBlock);
      if (!rect) continue;
      drawProgressBlock(
        c,
        fonts,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        resolveTemplate(pickText(rawBlock.label, ''), dataRoot),
        resolveTemplate(pickText(rawBlock.value_text, ''), dataRoot),
        resolvePercentage(rawBlock.percentage, rawBlock.value, rawBlock.max, dataRoot),
        rawBlock.label_font_size,
        rawBlock.value_font_size,
        rawBlock.bar_height,
        draw
      );
    } else if (type === 'sparkline') {
      const rect = blockRect(rawBlock);
      if (!rect) continue;
      const series = resolveSeries(rawBlock.values, dataRoot);
      if (series.length >= 2) draw.drawSparkline(c, rect.x, rect.y, rect.w, rect.h, series);
    } else if (type === 'segments') {
      const rect = blockRect(rawBlock);
      if (!rect) continue;
      drawSegmentedGauge(
        c,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        resolvePercentage(rawBlock.percentage, undefined, undefined, dataRoot),
        readInt(rawBlock.count, 10, 2, 20),
        readInt(rawBlock.gap, 3, 1, 12)
      );
    } else if (type === 'bar') {
      const rect = blockRect(rawBlock);
      if (!rect) continue;
      drawPercentageBar(
        c,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        resolvePercentage(rawBlock.percentage, undefined, undefined, dataRoot),
        rawBlock.color === 'white' ? PIXEL_WHITE : PIXEL_BLACK
      );
    } else if (type === 'line') {
      const x1 = readInt(rawBlock.x1, -1, 0, FRAME_WIDTH - 1);
      const y1 = readInt(rawBlock.y1, -1, 0, FRAME_HEIGHT - 1);
      const x2 = readInt(rawBlock.x2, -1, 0, FRAME_WIDTH - 1);
      const y2 = readInt(rawBlock.y2, -1, 0, FRAME_HEIGHT - 1);
      if (x1 >= 0 && y1 >= 0 && x2 >= 0 && y2 >= 0) {
        if (rawBlock.style === 'dashed' && y1 === y2) {
          draw.drawRule(c, Math.min(x1, x2), y1, Math.abs(x2 - x1), 'dashed');
        } else {
          c.drawLine(x1, y1, x2, y2, PIXEL_BLACK);
        }
      }
    } else if (type === 'rect') {
      const rect = blockRect(rawBlock);
      if (!rect) continue;
      if (rawBlock.fill === 'black') c.fillRect(rect.x, rect.y, rect.w, rect.h, PIXEL_BLACK);
      else if (rawBlock.fill === 'white') c.fillRect(rect.x, rect.y, rect.w, rect.h, PIXEL_WHITE);
      if (rawBlock.stroke !== false) c.strokeRect(rect.x, rect.y, rect.w, rect.h, PIXEL_BLACK);
    }
  }
}

function isBlockVisible(
  value: boolean | string | undefined,
  dataRoot: Record<string, unknown>
): boolean {
  if (value === undefined) return true;
  if (typeof value === 'boolean') return value;
  const resolved = resolveTemplate(value, dataRoot).trim().toLowerCase();
  return resolved === 'true' || resolved === '1' || resolved === 'yes' || resolved === 'on';
}

function drawSegmentedGauge(
  c: BitmapCanvas,
  x: number,
  y: number,
  w: number,
  h: number,
  percentage: number,
  count: number,
  gap: number
): void {
  const totalGap = gap * (count - 1);
  const cellW = Math.max(1, Math.floor((w - totalGap) / count));
  const usedW = cellW * count + totalGap;
  const offsetX = x + Math.max(0, Math.floor((w - usedW) / 2));
  const filled = percentage <= 0 ? 0 : Math.min(count, Math.ceil((percentage * count) / 100));
  for (let index = 0; index < count; index++) {
    const cellX = offsetX + index * (cellW + gap);
    c.strokeRect(cellX, y, cellW, h, PIXEL_BLACK);
    if (index < filled && cellW > 4 && h > 4) {
      c.fillRect(cellX + 2, y + 2, cellW - 4, h - 4, PIXEL_BLACK);
    }
  }
}

function drawPercentageBar(
  c: BitmapCanvas,
  x: number,
  y: number,
  w: number,
  h: number,
  percentage: number,
  color: number
): void {
  c.strokeRect(x, y, w, h, color);
  const innerW = Math.max(0, w - 4);
  const innerH = Math.max(0, h - 4);
  const fillW = Math.floor((innerW * percentage) / 100);
  if (fillW > 0 && innerH > 0) c.fillRect(x + 2, y + 2, fillW, innerH, color);
}

function drawMetricBlock(
  c: BitmapCanvas,
  fonts: FontSet,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  series: number[],
  draw: FrameDrawKit
): void {
  c.strokeRect(x, y, w, h, PIXEL_BLACK);
  draw.drawText(c, fonts.sans12, label, x + 7, y + 4, { maxWidth: w - 14, ellipsis: true });
  draw.drawText(c, fonts.sans16, value, x + 7, y + 27, { maxWidth: w - 14, ellipsis: true });
  if (series.length >= 2 && h >= 54) {
    draw.drawSparkline(c, x + 7, y + h - 18, w - 14, 10, series);
  }
}

function drawProgressBlock(
  c: BitmapCanvas,
  fonts: FontSet,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  valueText: string,
  percentage: number,
  labelFontSize: number | undefined,
  valueFontSize: number | undefined,
  barHeight: number | undefined,
  draw: FrameDrawKit
): void {
  const labelFont = labelFontSize === 16 ? fonts.sans16 : fonts.sans12;
  const valueFont = valueFontSize === 16 ? fonts.sans16 : fonts.sans12;
  const labelTextW = textWidthFallback(labelFont, draw.fallbackForFont(labelFont), label);
  const valueTextW = valueText
    ? textWidthFallback(valueFont, draw.fallbackForFont(valueFont), valueText)
    : 0;
  const labelW = Math.min(Math.max(labelTextW + 8, 58), Math.round(w * 0.36));
  const barX = x + labelW;
  const valueW = valueText ? Math.min(Math.max(valueTextW + 4, 34), 78) : 0;
  const barW = Math.max(12, w - labelW - valueW - 10);
  const barH = Math.max(4, Math.min(barHeight ?? 9, h - 4));
  const centerY = y + Math.round(h / 2);
  const barY = centerY - Math.floor(barH / 2);
  draw.drawTextCenteredY(c, labelFont, label, x, centerY, {
    maxWidth: labelW - 6,
    ellipsis: true,
  });
  c.strokeRect(barX, barY, barW, barH, PIXEL_BLACK);
  const fillW = Math.max(0, Math.min(barW - 2, Math.round(((barW - 2) * percentage) / 100)));
  if (fillW > 0) c.fillRect(barX + 1, barY + 1, fillW, barH - 2, PIXEL_BLACK);
  if (valueText) {
    draw.drawTextCenteredY(c, valueFont, valueText, x + w, centerY, {
      align: 'right',
      maxWidth: valueW,
      ellipsis: true,
    });
  }
}
