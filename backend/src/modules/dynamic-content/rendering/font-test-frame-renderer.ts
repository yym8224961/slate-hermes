import { FRAME_HEIGHT, FRAME_WIDTH, ICON_FONT_TEST_SAMPLE } from 'shared';
import { BitmapCanvas, PIXEL_BLACK, PIXEL_WHITE } from './bitmap-canvas';
import type { DynamicRenderContext } from './dynamic-render-context';
import { type FrameDrawKit } from './frame-draw-kit';
import { CONTENT_LEFT, CONTENT_WIDTH, STATUS_BAR_H } from './frame-renderer-layout';
import { getDeviceFontEntry, type DeviceFontCatalogEntry } from './fonts/font-catalog';
import { type BitmapFont } from './fonts/bitmap-font';
import { type FontSet } from './fonts/dynamic-frame-font.service';
import {
  fontReadingLines,
  fontSpecimen,
  fontTestLineGap,
  fontTestSampleText,
  missingGlyphs,
  readFontId,
  type FontSpecimen,
} from './fonts/font-test-utils';

const FONT_TEST_COMPACT_METRICS: Record<string, { lineHeight: number; baseLine: number }> = {
  fusion_pixel_10: { lineHeight: 10, baseLine: 2 },
  fusion_pixel_12: { lineHeight: 12, baseLine: 2 },
  ark_pixel_10: { lineHeight: 10, baseLine: 2 },
  ark_pixel_12: { lineHeight: 12, baseLine: 2 },
  ark_pixel_16: { lineHeight: 16, baseLine: 3 },
};

export function renderFontTestFrame(
  c: BitmapCanvas,
  fonts: FontSet,
  ctx: DynamicRenderContext,
  draw: FrameDrawKit
): void {
  const fontId = readFontId(ctx.config.font_id);
  const entry = getDeviceFontEntry(fontId);
  const sourceFont = fonts.catalog[entry.id] ?? fonts.sans16;
  const sampleFont = compactFontTestFont(sourceFont, entry);
  const invert = ctx.config.invert === true;
  const specimenKind =
    entry.kind === 'latin' && sampleFont.lineHeight >= 28 ? 'display' : entry.kind;
  const specimen = fontSpecimen(specimenKind, entry.id);
  const sampleForMissing = fontTestSampleText(specimenKind, specimen);
  const missing = missingGlyphs(sampleFont, sampleForMissing);

  if (invert) {
    c.fillRect(0, STATUS_BAR_H, FRAME_WIDTH, FRAME_HEIGHT - STATUS_BAR_H, PIXEL_BLACK);
  }
  const fg = invert ? PIXEL_WHITE : PIXEL_BLACK;

  if (specimenKind === 'icon') renderFontIconSpecimen(c, sampleFont, fg, draw);
  else if (specimenKind === 'display') {
    renderFontDisplaySpecimen(c, sampleFont, entry, specimen, fg, missing.length, draw);
  } else {
    renderFontReadingSpecimen(c, sampleFont, entry, specimen, fg, missing.length, draw);
  }
}

function renderFontReadingSpecimen(
  c: BitmapCanvas,
  sampleFont: BitmapFont,
  entry: DeviceFontCatalogEntry,
  specimen: FontSpecimen,
  fg: number,
  missingCount: number,
  draw: FrameDrawKit
): void {
  const x = CONTENT_LEFT;
  const maxWidth = CONTENT_WIDTH;
  const bottom = FRAME_HEIGHT - 8;
  const lineGap = fontTestLineGap(sampleFont);
  let y = STATUS_BAR_H + 9;

  y += draw.drawText(c, sampleFont, entry.label, x, y, {
    maxWidth,
    ellipsis: true,
    color: fg,
  });
  y += Math.max(4, Math.floor(lineGap / 2));

  y += draw.drawText(
    c,
    sampleFont,
    `${entry.sizePx}px line ${sampleFont.lineHeight} glyphs ${sampleFont.glyphs.size}`,
    x,
    y,
    {
      maxWidth,
      ellipsis: true,
      color: fg,
    }
  );
  y += lineGap;
  draw.drawRuleColor(c, x, y, maxWidth, 'dashed', fg);
  y += lineGap + 2;

  for (const line of fontReadingLines(entry, specimen, sampleFont, missingCount)) {
    if (y + sampleFont.lineHeight > bottom) break;
    const used = draw.drawText(c, sampleFont, line, x, y, {
      maxWidth,
      maxLines: sampleFont.lineHeight <= 12 ? 2 : 1,
      ellipsis: true,
      lineGap: 1,
      color: fg,
    });
    y += used + lineGap;
  }
}

function renderFontDisplaySpecimen(
  c: BitmapCanvas,
  sampleFont: BitmapFont,
  entry: DeviceFontCatalogEntry,
  specimen: FontSpecimen,
  fg: number,
  missingCount: number,
  draw: FrameDrawKit
): void {
  const huge = sampleFont.lineHeight >= 56;
  if (huge) {
    const lines = [specimen.hero, '86%', missingCount > 0 ? `missing ${missingCount}` : '+12 -04'];
    const ySlots = [36, 128, 220];
    lines.forEach((text, index) => {
      draw.drawText(c, sampleFont, text, 200, ySlots[index]!, {
        align: 'center',
        maxWidth: CONTENT_WIDTH,
        ellipsis: true,
        color: fg,
      });
    });
    return;
  }

  draw.drawText(c, sampleFont, specimen.hero, 200, 34, {
    align: 'center',
    maxWidth: CONTENT_WIDTH,
    ellipsis: true,
    color: fg,
  });
  draw.drawRuleColor(c, 72, 92, 256, 'dashed', fg);

  const values = ['86%', '+12', '-04'];
  const colW = Math.floor(CONTENT_WIDTH / values.length);
  values.forEach((value, index) => {
    const centerX = CONTENT_LEFT + index * colW + Math.floor(colW / 2);
    draw.drawText(c, sampleFont, value, centerX, 112, {
      align: 'center',
      maxWidth: colW - 10,
      ellipsis: true,
      color: fg,
    });
  });

  draw.drawRuleColor(c, 72, 176, 256, 'dashed', fg);
  draw.drawText(c, sampleFont, specimen.glyphs[0] ?? 'OK RUN', 200, 190, {
    align: 'center',
    maxWidth: CONTENT_WIDTH,
    ellipsis: true,
    color: fg,
  });

  const footer = missingCount > 0 ? `${entry.label} missing ${missingCount}` : entry.label;
  draw.drawText(c, sampleFont, footer, 200, 246, {
    align: 'center',
    maxWidth: CONTENT_WIDTH,
    ellipsis: true,
    color: fg,
  });
}

function renderFontIconSpecimen(
  c: BitmapCanvas,
  sampleFont: BitmapFont,
  fg: number,
  draw: FrameDrawKit
): void {
  const icons = Array.from(ICON_FONT_TEST_SAMPLE).filter((ch) => ch.trim().length > 0);
  const large = sampleFont.lineHeight >= 24;
  const cols = large ? 8 : 12;
  const startY = STATUS_BAR_H + 12;
  const cellW = Math.floor(CONTENT_WIDTH / cols);
  const cellH = sampleFont.lineHeight + (large ? 18 : 10);
  const rows = Math.max(1, Math.floor((FRAME_HEIGHT - startY - 10) / cellH));
  icons.slice(0, cols * rows).forEach((icon, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = CONTENT_LEFT + col * cellW;
    const y = startY + row * cellH;
    draw.drawText(c, sampleFont, icon, x + Math.floor(cellW / 2), y, {
      align: 'center',
      maxWidth: cellW,
      color: fg,
    });
  });

  if (!large) {
    draw.drawRuleColor(c, CONTENT_LEFT, 244, CONTENT_WIDTH, 'dashed', fg);
    draw.drawText(c, sampleFont, '\uf240 \uf1eb \uf028 \uf071 \uf0f3 \uf011 \uf013', 200, 256, {
      align: 'center',
      maxWidth: CONTENT_WIDTH,
      ellipsis: true,
      color: fg,
    });
  }
}

function compactFontTestFont(font: BitmapFont, entry: DeviceFontCatalogEntry): BitmapFont {
  const metrics = FONT_TEST_COMPACT_METRICS[entry.id];
  if (!metrics) return font;
  return {
    ...font,
    lineHeight: metrics.lineHeight,
    baseLine: metrics.baseLine,
  };
}
