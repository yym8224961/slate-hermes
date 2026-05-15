import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FRAME_BYTES, FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import { BitmapCanvas, PIXEL_BLACK, PIXEL_WHITE } from './bitmap-canvas';
import { hasGlyph, loadBitmapFont, textWidth, type BitmapFont } from './bitmap-font';

export interface DynamicRenderContext {
  type: string;
  title?: string | null;
  config: Record<string, unknown>;
  data: Record<string, unknown> | null;
  renderedAt: Date;
}

interface FontSet {
  sans16: BitmapFont;
  pixel12: BitmapFont;
}

interface TextOptions {
  align?: 'left' | 'center' | 'right';
  maxWidth?: number;
  maxLines?: number;
  ellipsis?: boolean;
  lineGap?: number;
  color?: number;
}

const STATUS_BAR_H = 24;
const CONTENT_TOP = STATUS_BAR_H + 10;
const CONTENT_LEFT = 20;
const CONTENT_RIGHT = FRAME_WIDTH - 20;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const FALLBACK_TEXT = '暂无数据';

@Injectable()
export class DynamicFrameRendererService implements OnModuleInit {
  private fonts: FontSet | null = null;

  async onModuleInit(): Promise<void> {
    this.fonts = {
      sans16: await loadBitmapFont(resolveFontPath('source-han-sans-16.json')),
      pixel12: await loadBitmapFont(resolveFontPath('fusion-pixel-12.json')),
    };
  }

  async render(ctx: DynamicRenderContext): Promise<Buffer> {
    const fonts = await this.getFonts();
    const c = new BitmapCanvas(FRAME_WIDTH, FRAME_HEIGHT);
    c.clear(PIXEL_WHITE);
    this.clearSystemStatusArea(c);

    switch (ctx.type) {
      case 'date':
        this.renderDate(c, fonts, ctx);
        break;
      case 'weather':
        this.renderWeather(c, fonts, ctx);
        break;
      case 'history_today':
        this.renderHistoryToday(c, fonts, ctx);
        break;
      case 'dashboard':
        this.renderDashboard(c, fonts, ctx);
        break;
      default:
        this.renderFallback(c, fonts, `未知动态类型 ${ctx.type}`);
        break;
    }

    const raw = c.toRaw1bpp();
    if (raw.byteLength !== FRAME_BYTES) {
      throw new Error(`dynamic frame size mismatch: ${raw.byteLength} vs ${FRAME_BYTES}`);
    }
    return raw;
  }

  private async getFonts(): Promise<FontSet> {
    if (this.fonts) return this.fonts;
    this.fonts = {
      sans16: await loadBitmapFont(resolveFontPath('source-han-sans-16.json')),
      pixel12: await loadBitmapFont(resolveFontPath('fusion-pixel-12.json')),
    };
    return this.fonts;
  }

  private clearSystemStatusArea(c: BitmapCanvas): void {
    c.fillRect(0, 0, FRAME_WIDTH, STATUS_BAR_H, PIXEL_WHITE);
  }

  private renderDate(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const data = ctx.data ?? {};
    const tz = timezoneFromConfig(ctx.config);
    const year = pickText(data.year, formatDatePart(ctx.renderedAt, 'year', tz));
    const month = pickText(data.month, monthFromMonthDay(data.monthDay, ctx.renderedAt, tz));
    const day = pickText(data.day, dayFromMonthDay(data.monthDay, ctx.renderedAt, tz));
    const weekday = pickText(data.weekdayCN, '');
    const lunarDate = pickText(data.lunarDate, pickText(data.lunar, ''));
    const ganzhi = [data.ganzhiYear, data.ganzhiMonth, data.ganzhiDay]
      .map((v) => pickText(v, ''))
      .filter(Boolean)
      .join('  ');
    const solarTerm = pickText(data.solarTerm, '');
    const nextSolarTerm = pickText(data.nextSolarTerm, '');
    const nextSolarTermDays =
      typeof data.nextSolarTermDays === 'number' && Number.isFinite(data.nextSolarTermDays)
        ? data.nextSolarTermDays
        : null;
    const yi = readStringArray(data.yi).slice(0, 4).join(' ');
    const ji = readStringArray(data.ji).slice(0, 4).join(' ');

    this.drawText(c, fonts.sans16, `${year} 年 ${Number(month)} 月`, CONTENT_LEFT, 36, {
      maxWidth: 160,
      ellipsis: true,
    });
    if (weekday) {
      this.drawText(c, fonts.sans16, weekday, CONTENT_RIGHT, 36, {
        align: 'right',
        maxWidth: 100,
        ellipsis: true,
      });
    }

    this.drawLargeDigits(c, fonts.pixel12, day, FRAME_WIDTH / 2, 58, 9, 'center');
    this.drawText(c, fonts.sans16, `${Number(month)}月`, 270, 92, { maxWidth: 48 });

    if (ganzhi) {
      this.drawText(c, fonts.sans16, ganzhi, FRAME_WIDTH / 2, 166, {
        align: 'center',
        maxWidth: CONTENT_WIDTH,
        ellipsis: true,
      });
    }
    if (lunarDate) {
      this.drawText(c, fonts.sans16, lunarDate, FRAME_WIDTH / 2, 192, {
        align: 'center',
        maxWidth: CONTENT_WIDTH,
        ellipsis: true,
      });
    }

    this.drawRule(c, CONTENT_LEFT, 214, CONTENT_WIDTH, 'dashed');

    const term = solarTerm || nextSolarTerm;
    if (term) {
      this.drawText(c, fonts.sans16, solarTerm ? '今日节气' : '下个节气', CONTENT_LEFT, 222, {
        maxWidth: 76,
      });
      this.drawText(c, fonts.sans16, term, 108, 222, { maxWidth: 70, ellipsis: true });
      const daysLabel =
        nextSolarTermDays === null
          ? ''
          : nextSolarTermDays === 0
            ? '就是今天'
            : `${nextSolarTermDays} 天后`;
      if (daysLabel) {
        this.drawText(c, fonts.sans16, daysLabel, CONTENT_RIGHT, 222, {
          align: 'right',
          maxWidth: 90,
          ellipsis: true,
        });
      }
    }

    if (yi) this.drawLabeledText(c, fonts, '宜', yi, CONTENT_LEFT, 247, CONTENT_WIDTH);
    if (ji) this.drawLabeledText(c, fonts, '忌', ji, CONTENT_LEFT, 272, CONTENT_WIDTH);
  }

  private renderWeather(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const data = ctx.data ?? {};
    const config = ctx.config;
    const place = pickText(config.location_label, ctx.title ?? '天气');
    const summary = pickText(data.summary, pickText(data.text, FALLBACK_TEXT));
    const temp = pickText(data.tempC, pickText(data.temp, '--'));
    const feelsLike = pickText(data.feelsLikeC, pickText(data.feelsLike, ''));
    const humidity = pickText(data.humidity, '--');
    const wind = pickText(data.windDisplay, pickText(data.wind, '--'));
    const fc = Array.isArray(data.fc) ? data.fc.slice(0, 3) : [];

    this.drawText(c, fonts.sans16, place, CONTENT_LEFT, 36, { maxWidth: 160, ellipsis: true });
    this.drawText(c, fonts.sans16, summary, CONTENT_RIGHT, 36, {
      align: 'right',
      maxWidth: 120,
      ellipsis: true,
    });

    this.drawWeatherIcon(c, normalizeWeatherCode(data.code), 90, 101, 'large');
    this.drawLargeDigits(c, fonts.pixel12, temp, 160, 72, 6, 'left');
    this.drawText(
      c,
      fonts.sans16,
      '°',
      160 + Math.min(104, textWidth(fonts.pixel12, temp) * 6 + 6),
      72,
      {
        maxWidth: 20,
      }
    );

    this.drawText(c, fonts.sans16, feelsLike ? `体感 ${feelsLike}°` : '体感 --', 278, 86, {
      maxWidth: 96,
      ellipsis: true,
    });
    this.drawText(c, fonts.sans16, humidity === '--' ? '湿度 --' : `湿度 ${humidity}%`, 278, 113, {
      maxWidth: 96,
      ellipsis: true,
    });
    this.drawText(c, fonts.sans16, wind, 278, 140, {
      maxWidth: 96,
      ellipsis: true,
    });

    const forecast = fc.length > 0 ? fc : [null, null, null];
    const colW = Math.floor(CONTENT_WIDTH / 3);
    forecast.slice(0, 3).forEach((item, index) => {
      const record = isRecord(item) ? item : {};
      const x = CONTENT_LEFT + index * colW;
      if (index > 0) c.drawVLine(x, 190, 94, PIXEL_BLACK);
      const label = pickText(record.label, ['今日', '明日', '后天'][index] ?? '');
      const text = pickText(record.text, forecastTextFromVal(record.val));
      const min = pickText(record.tempMin, '');
      const max = pickText(record.tempMax, '');
      const range = min && max ? `${min}~${max}°` : forecastRangeFromVal(record.val);
      const center = Math.round(x + colW / 2);
      this.drawText(c, fonts.sans16, label, center, 190, {
        align: 'center',
        maxWidth: colW - 12,
        ellipsis: true,
      });
      this.drawWeatherIcon(c, normalizeWeatherCode(record.code), center, 219, 'tiny');
      this.drawText(c, fonts.sans16, range || '--', center, 246, {
        align: 'center',
        maxWidth: colW - 12,
        ellipsis: true,
      });
      this.drawText(c, fonts.sans16, text || '--', center, 270, {
        align: 'center',
        maxWidth: colW - 12,
        ellipsis: true,
      });
    });
  }

  private renderHistoryToday(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const data = ctx.data ?? {};
    const dateLabel = pickText(
      data.dateLabel,
      formatDatePart(ctx.renderedAt, 'cnMonthDay', timezoneFromConfig(ctx.config))
    );
    this.drawText(c, fonts.sans16, '历史上的今天', CONTENT_LEFT, 36, {
      maxWidth: 160,
      ellipsis: true,
    });
    this.drawText(c, fonts.sans16, dateLabel, CONTENT_RIGHT, 36, {
      align: 'right',
      maxWidth: 110,
      ellipsis: true,
    });

    const lines = [data.line0, data.line1, data.line2, data.line3]
      .map((v) => pickText(v, ''))
      .filter((v) => v.length > 0);
    const source = lines.length > 0 ? lines : [FALLBACK_TEXT];
    let y = 66;
    for (const line of source.slice(0, 4)) {
      const split = splitHistoryLine(line);
      if (split.year) {
        this.drawText(c, fonts.pixel12, split.year, CONTENT_LEFT, y + 5, { maxWidth: 42 });
        c.drawVLine(CONTENT_LEFT + 52, y + 1, 32, PIXEL_BLACK);
        this.drawText(c, fonts.sans16, split.text, CONTENT_LEFT + 68, y, {
          maxWidth: CONTENT_WIDTH - 68,
          maxLines: 2,
          ellipsis: true,
          lineGap: 4,
        });
      } else {
        this.drawText(c, fonts.sans16, split.text, CONTENT_LEFT, y, {
          maxWidth: CONTENT_WIDTH,
          maxLines: 2,
          ellipsis: true,
          lineGap: 4,
        });
      }
      y += 54;
    }
  }

  private renderDashboard(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const data = ctx.data ?? {};
    if (isRecord(data.layout) && Array.isArray(data.layout.blocks)) {
      this.renderDashboardLayout(c, fonts, ctx, data.layout);
      return;
    }

    const metrics = isRecord(data.metrics) ? Object.entries(data.metrics).slice(0, 4) : [];
    const title = pickText(data.title, ctx.title ?? '数据看板');
    const subtitle = pickText(data.subtitle, '');

    this.drawText(c, fonts.sans16, title, CONTENT_LEFT, CONTENT_TOP + 2, {
      maxWidth: 220,
      ellipsis: true,
    });
    this.drawText(
      c,
      fonts.pixel12,
      formatShortTime(data.updated_at, ctx.renderedAt, timezoneFromConfig(ctx.config)),
      CONTENT_RIGHT,
      CONTENT_TOP + 7,
      {
        align: 'right',
        maxWidth: 110,
        ellipsis: true,
      }
    );
    if (subtitle) {
      this.drawText(c, fonts.pixel12, subtitle, CONTENT_LEFT, 62, {
        maxWidth: CONTENT_WIDTH,
        ellipsis: true,
      });
    }
    this.drawRule(c, CONTENT_LEFT, subtitle ? 82 : 66, CONTENT_WIDTH, 'solid');

    if (metrics.length === 0) {
      this.drawText(c, fonts.sans16, '等待数据推送', 200, 145, { align: 'center' });
      this.drawText(c, fonts.pixel12, 'POST /contents/:id/data', 200, 170, { align: 'center' });
      return;
    }

    const startY = subtitle ? 96 : 82;
    const colW = 166;
    metrics.forEach(([key, value], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = CONTENT_LEFT + col * (colW + 18);
      const y = startY + row * 86;
      this.drawText(c, fonts.sans16, formatLabel(key), x + 8, y + 8, {
        maxWidth: colW,
        ellipsis: true,
      });
      const valueText = pickText(value, '--');
      this.drawText(c, fonts.sans16, valueText, x + 8, y + 38, {
        maxWidth: colW - 16,
        ellipsis: true,
      });
      const series = readNumberArray(data.series);
      if (series.length >= 2) this.drawSparkline(c, x + 8, y + 60, colW - 16, 9, series);
      else
        this.drawSmallSpark(
          c,
          x + 8,
          y + 68,
          colW - 16,
          String(key).length + String(valueText).length
        );
      c.strokeRect(x, y, colW, 74, PIXEL_BLACK);
    });
  }

  private renderFallback(c: BitmapCanvas, fonts: FontSet, message: string): void {
    this.drawText(c, fonts.sans16, message, 200, 140, {
      align: 'center',
      maxWidth: 320,
      maxLines: 2,
      ellipsis: true,
    });
  }

  private renderDashboardLayout(
    c: BitmapCanvas,
    fonts: FontSet,
    ctx: DynamicRenderContext,
    layout: Record<string, unknown>
  ): void {
    const dataRoot = isRecord(ctx.data?.data)
      ? (ctx.data.data as Record<string, unknown>)
      : (ctx.data ?? {});
    const title = pickText(layout.title, pickText(ctx.data?.title, ctx.title ?? '数据看板'));
    if (title) {
      this.drawText(c, fonts.sans16, title, CONTENT_LEFT, 34, { maxWidth: 220, ellipsis: true });
    }
    const blocks = Array.isArray(layout.blocks) ? layout.blocks.slice(0, 24) : [];
    for (const rawBlock of blocks) {
      if (!isRecord(rawBlock)) continue;
      const type = pickText(rawBlock.type, '');
      if (type === 'text') {
        const rect = blockRect(rawBlock);
        if (!rect) continue;
        const font = rawBlock.size === 'sm' ? fonts.pixel12 : fonts.sans16;
        this.drawText(
          c,
          font,
          resolveTemplate(pickText(rawBlock.value, ''), dataRoot),
          rect.x,
          rect.y,
          {
            align: readAlign(rawBlock.align),
            maxWidth: rect.w,
            maxLines: readInt(rawBlock.max_lines, 1, 1, 4),
            ellipsis: true,
          }
        );
      } else if (type === 'metric') {
        const rect = blockRect(rawBlock);
        if (!rect) continue;
        this.drawMetricBlock(
          c,
          fonts,
          rect.x,
          rect.y,
          rect.w,
          rect.h,
          resolveTemplate(pickText(rawBlock.label, ''), dataRoot),
          resolveTemplate(pickText(rawBlock.value, ''), dataRoot),
          resolveSeries(rawBlock.sparkline, dataRoot)
        );
      } else if (type === 'sparkline') {
        const rect = blockRect(rawBlock);
        if (!rect) continue;
        const series = resolveSeries(rawBlock.values, dataRoot);
        if (series.length >= 2) this.drawSparkline(c, rect.x, rect.y, rect.w, rect.h, series);
      } else if (type === 'line') {
        const x1 = readInt(rawBlock.x1, -1, 0, FRAME_WIDTH - 1);
        const y1 = readInt(rawBlock.y1, -1, STATUS_BAR_H, FRAME_HEIGHT - 1);
        const x2 = readInt(rawBlock.x2, -1, 0, FRAME_WIDTH - 1);
        const y2 = readInt(rawBlock.y2, -1, STATUS_BAR_H, FRAME_HEIGHT - 1);
        if (x1 >= 0 && y1 >= STATUS_BAR_H && x2 >= 0 && y2 >= STATUS_BAR_H) {
          if (rawBlock.style === 'dashed' && y1 === y2) {
            this.drawRule(c, Math.min(x1, x2), y1, Math.abs(x2 - x1), 'dashed');
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

  private drawLabeledText(
    c: BitmapCanvas,
    fonts: FontSet,
    label: string,
    value: string,
    x: number,
    y: number,
    w: number
  ): void {
    c.strokeRect(x, y - 1, 20, 18, PIXEL_BLACK);
    this.drawText(c, fonts.sans16, label, x + 3, y - 2, { maxWidth: 14 });
    this.drawText(c, fonts.sans16, value, x + 30, y - 2, {
      maxWidth: w - 30,
      ellipsis: true,
    });
  }

  private drawMetricStrip(c: BitmapCanvas, fonts: FontSet, items: Array<[string, string]>): void {
    const y = 160;
    const colW = Math.floor(CONTENT_WIDTH / items.length);
    items.forEach(([label, value], index) => {
      const x = CONTENT_LEFT + index * colW;
      if (index > 0) c.drawVLine(x - 5, y - 2, 22, PIXEL_BLACK);
      this.drawText(c, fonts.pixel12, label, x, y + 1, { maxWidth: 32, ellipsis: true });
      this.drawText(c, fonts.pixel12, value, x + 39, y + 1, {
        maxWidth: colW - 42,
        ellipsis: true,
      });
    });
  }

  private drawRule(
    c: BitmapCanvas,
    x: number,
    y: number,
    w: number,
    style: 'solid' | 'dashed'
  ): void {
    if (style === 'solid') {
      c.drawHLine(x, y, w, PIXEL_BLACK);
      return;
    }
    for (let xx = 0; xx < w; xx += 8) c.drawHLine(x + xx, y, Math.min(4, w - xx), PIXEL_BLACK);
  }

  private drawMetricBlock(
    c: BitmapCanvas,
    fonts: FontSet,
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    value: string,
    series: number[]
  ): void {
    c.strokeRect(x, y, w, h, PIXEL_BLACK);
    this.drawText(c, fonts.pixel12, label, x + 7, y + 8, { maxWidth: w - 14, ellipsis: true });
    this.drawText(c, fonts.sans16, value, x + 7, y + 32, { maxWidth: w - 14, ellipsis: true });
    if (series.length >= 2 && h >= 54) {
      this.drawSparkline(c, x + 7, y + h - 18, w - 14, 10, series);
    }
  }

  private drawLargeDigits(
    c: BitmapCanvas,
    font: BitmapFont,
    text: string,
    x: number,
    y: number,
    scale: number,
    align: 'left' | 'center' | 'right' = 'center'
  ): void {
    const width = textWidth(font, text) * scale;
    let penX = align === 'center' ? Math.round(x - width / 2) : align === 'right' ? x - width : x;
    for (const ch of text) {
      const codepoint = ch.codePointAt(0)!;
      const glyph = font.glyphs.get(codepoint);
      const adv = Math.round((glyph?.adv_w ?? 96) / 16) * scale;
      if (!glyph) {
        penX += adv;
        continue;
      }
      let bit = glyph.bitmap_index * 8;
      const startX = penX + glyph.ofs_x * scale;
      const startY =
        y + Math.max(0, font.lineHeight - font.baseLine - glyph.box_h - glyph.ofs_y) * scale;
      for (let yy = 0; yy < glyph.box_h; yy++) {
        for (let xx = 0; xx < glyph.box_w; xx++) {
          const byte = font.bitmap[bit >> 3] ?? 0;
          const on = (byte & (0x80 >> (bit & 7))) !== 0;
          if (on) c.fillRect(startX + xx * scale, startY + yy * scale, scale, scale, PIXEL_BLACK);
          bit++;
        }
      }
      penX += adv;
    }
  }

  private drawWeatherIcon(
    c: BitmapCanvas,
    code: number | null,
    cx: number,
    cy: number,
    size: 'tiny' | 'small' | 'large' = 'large'
  ): void {
    const scale = size === 'small' ? 0.42 : size === 'tiny' ? 0.32 : 1;
    if (code !== null && isCloudyCode(code)) {
      this.drawCloud(c, cx, cy, scale);
      if (isPartlyCloudyCode(code))
        this.drawSunMark(c, cx - Math.round(34 * scale), cy - Math.round(22 * scale), scale * 0.55);
      return;
    }
    if (code !== null && isRainCode(code)) {
      this.drawCloud(c, cx, cy - Math.round(8 * scale), scale);
      const drops = size === 'small' ? [cx - 8, cx + 8] : [cx - 28, cx - 4, cx + 20];
      for (const x of drops) {
        const startY = cy + Math.round((size === 'tiny' ? 26 : 30) * scale);
        const endY = cy + Math.round((size === 'tiny' ? 38 : 47) * scale);
        c.drawLine(x, startY, x - Math.round(8 * scale), endY, PIXEL_BLACK);
      }
      return;
    }
    if (code !== null && isSnowCode(code)) {
      this.drawCloud(c, cx, cy - Math.round(8 * scale), scale);
      const flakes = size === 'small' ? [cx - 9, cx + 9] : [cx - 24, cx, cx + 24];
      for (const x of flakes) {
        const yy = cy + Math.round(38 * scale);
        const r = Math.max(3, Math.round(7 * scale));
        c.drawLine(x - r, yy, x + r, yy, PIXEL_BLACK);
        c.drawLine(x, yy - r, x, yy + r, PIXEL_BLACK);
      }
      return;
    }
    if (code !== null && isFogCode(code)) {
      for (let i = 0; i < 4; i++) {
        const yy = cy - Math.round(18 * scale) + i * Math.round(12 * scale);
        c.drawHLine(cx - Math.round(34 * scale), yy, Math.round(68 * scale), PIXEL_BLACK);
      }
      return;
    }
    this.drawSunMark(c, cx, cy, scale);
  }

  private drawSparkline(
    c: BitmapCanvas,
    x: number,
    y: number,
    w: number,
    h: number,
    values: number[]
  ): void {
    if (values.length < 2 || w <= 1 || h <= 1) return;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    let lastX = x;
    let lastY = y + h - Math.round(((values[0]! - min) / range) * h);
    for (let i = 1; i < values.length; i++) {
      const xx = x + Math.round((w * i) / (values.length - 1));
      const yy = y + h - Math.round(((values[i]! - min) / range) * h);
      c.drawLine(lastX, lastY, xx, yy, PIXEL_BLACK);
      lastX = xx;
      lastY = yy;
    }
  }

  private drawSunMark(c: BitmapCanvas, cx: number, cy: number, scale = 1): void {
    const inner = Math.max(5, Math.round(21 * scale));
    const outer = Math.max(inner + 3, Math.round(28 * scale));
    c.strokeCircle(cx, cy, outer, PIXEL_BLACK);
    c.strokeCircle(cx, cy, inner, PIXEL_BLACK);
    for (let i = 0; i < 12; i++) {
      const a = (Math.PI * 2 * i) / 12;
      const r0 = Math.round(outer + 8 * scale);
      const r1 = Math.round(outer + 19 * scale);
      c.drawLine(
        Math.round(cx + Math.cos(a) * r0),
        Math.round(cy + Math.sin(a) * r0),
        Math.round(cx + Math.cos(a) * r1),
        Math.round(cy + Math.sin(a) * r1),
        PIXEL_BLACK
      );
    }
  }

  private drawCloud(c: BitmapCanvas, cx: number, cy: number, scale = 1): void {
    const sx = (n: number) => Math.round(n * scale);
    c.strokeCircle(cx - sx(25), cy + sx(2), Math.max(5, sx(18)), PIXEL_BLACK);
    c.strokeCircle(cx, cy - sx(9), Math.max(7, sx(27)), PIXEL_BLACK);
    c.strokeCircle(cx + sx(29), cy + sx(6), Math.max(5, sx(19)), PIXEL_BLACK);
    c.fillRect(cx - sx(50), cy + sx(4), sx(101), sx(30), PIXEL_WHITE);
    c.drawHLine(cx - sx(48), cy + sx(32), sx(96), PIXEL_BLACK);
    c.drawLine(cx - sx(48), cy + sx(32), cx - sx(39), cy + sx(15), PIXEL_BLACK);
    c.drawLine(cx + sx(48), cy + sx(32), cx + sx(38), cy + sx(17), PIXEL_BLACK);
  }

  private drawSmallSpark(c: BitmapCanvas, x: number, y: number, w: number, seed: number): void {
    let lastX = x;
    let lastY = y + 10;
    for (let i = 1; i <= 8; i++) {
      const xx = x + Math.round((w * i) / 8);
      const yy = y + 4 + ((seed + i * 7) % 14);
      c.drawLine(lastX, lastY, xx, yy, PIXEL_BLACK);
      lastX = xx;
      lastY = yy;
    }
  }

  private drawText(
    c: BitmapCanvas,
    font: BitmapFont,
    text: string,
    x: number,
    y: number,
    opts: TextOptions = {}
  ): number {
    const lineGap = opts.lineGap ?? 3;
    const lines = wrapText(
      font,
      text,
      opts.maxWidth ?? FRAME_WIDTH,
      opts.maxLines ?? 1,
      opts.ellipsis ?? false
    );
    let cursorY = y;
    for (const line of lines) {
      const width = textWidth(font, line);
      const drawX =
        opts.align === 'center'
          ? Math.round(x - width / 2)
          : opts.align === 'right'
            ? x - width
            : x;
      c.drawText(
        font,
        line,
        drawX,
        cursorY + font.lineHeight - font.baseLine,
        opts.color ?? PIXEL_BLACK
      );
      cursorY += font.lineHeight + lineGap;
    }
    return lines.length * font.lineHeight + Math.max(0, lines.length - 1) * lineGap;
  }
}

function resolveFontPath(file: string): string {
  const candidates = [
    resolve(process.cwd(), 'device-fonts', file),
    resolve(process.cwd(), 'backend', 'device-fonts', file),
    resolve(process.cwd(), '..', 'backend', 'device-fonts', file),
    join(import.meta.dir, '..', '..', '..', 'device-fonts', file),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`device font not found: ${file}`);
  return found;
}

function pickText(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s.length > 0 ? s : fallback;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
    .filter((v) => v.length > 0);
}

function readNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN))
    .filter((v) => Number.isFinite(v));
}

function readInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function readAlign(value: unknown): 'left' | 'center' | 'right' {
  return value === 'center' || value === 'right' ? value : 'left';
}

function blockRect(
  block: Record<string, unknown>
): { x: number; y: number; w: number; h: number } | null {
  const x = readInt(block.x, -1, 0, FRAME_WIDTH - 1);
  const y = readInt(block.y, -1, STATUS_BAR_H, FRAME_HEIGHT - 1);
  const w = readInt(block.w, -1, 1, FRAME_WIDTH);
  const h = readInt(block.h, -1, 1, FRAME_HEIGHT - STATUS_BAR_H);
  if (x < 0 || y < STATUS_BAR_H || w < 1 || h < 1) return null;
  return {
    x,
    y,
    w: Math.min(w, FRAME_WIDTH - x),
    h: Math.min(h, FRAME_HEIGHT - y),
  };
}

function resolveTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, path: string) => {
    const value = resolvePath(data, path);
    if (Array.isArray(value)) return value.join(' ');
    if (value === null || value === undefined) return '';
    return String(value);
  });
}

function resolvePath(data: Record<string, unknown>, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split('.')) {
    if (!isRecord(cur) && !Array.isArray(cur)) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else {
      cur = cur[part];
    }
  }
  return cur;
}

function resolveSeries(value: unknown, data: Record<string, unknown>): number[] {
  if (Array.isArray(value)) return readNumberArray(value);
  if (typeof value !== 'string') return [];
  const match = value.match(/^\{([a-zA-Z0-9_.-]+)\}$/);
  if (match) return readNumberArray(resolvePath(data, match[1]!));
  return readNumberArray(
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

function forecastTextFromVal(value: unknown): string {
  const text = pickText(value, '');
  if (!text) return '';
  return text.replace(/\s+\S*~\S*°$/, '').trim();
}

function forecastRangeFromVal(value: unknown): string {
  const text = pickText(value, '');
  const m = text.match(/([^\s]+~[^\s]+°)$/);
  return m?.[1] ?? '';
}

function monthFromMonthDay(value: unknown, fallback: Date, timeZone: string): string {
  const text = pickText(value, formatDatePart(fallback, 'monthDay', timeZone));
  return String(Number(text.split(/[/-]/)[0] ?? 1));
}

function dayFromMonthDay(value: unknown, fallback: Date, timeZone: string): string {
  const text = pickText(value, formatDatePart(fallback, 'monthDay', timeZone));
  return String(Number(text.split(/[/-]/)[1] ?? text));
}

function isCloudyCode(code: number): boolean {
  return [101, 102, 103, 104, 150, 151, 152, 153].includes(code);
}

function isPartlyCloudyCode(code: number): boolean {
  return [102, 103, 151, 152].includes(code);
}

function isRainCode(code: number): boolean {
  return (code >= 300 && code < 400) || code === 1201;
}

function isSnowCode(code: number): boolean {
  return code >= 400 && code < 500;
}

function isFogCode(code: number): boolean {
  return [500, 501, 502, 509, 510, 511, 512, 513, 514, 515].includes(code);
}

function wrapText(
  font: BitmapFont,
  text: string,
  maxWidth: number,
  maxLines: number,
  ellipsis: boolean
): string[] {
  const source = text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
  if (!source) return [];
  const lines: string[] = [];
  let cur = '';
  for (const ch of source) {
    if (ch === '\n') {
      lines.push(cur);
      cur = '';
      continue;
    }
    const next = `${cur}${ch}`;
    if (textWidth(font, next) > maxWidth && cur.length > 0) {
      lines.push(cur);
      cur = ch;
      if (lines.length >= maxLines) break;
    } else {
      cur = next;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const clipped = lines.slice(0, maxLines).map((line) => filterDrawable(font, line));
  if (
    ellipsis &&
    clipped.length === maxLines &&
    textWidth(font, clipped[clipped.length - 1] ?? '') > maxWidth
  ) {
    clipped[clipped.length - 1] = ellipsize(font, clipped[clipped.length - 1]!, maxWidth);
  } else if (ellipsis && source.length > clipped.join('').length && clipped.length > 0) {
    clipped[clipped.length - 1] = ellipsize(font, clipped[clipped.length - 1]!, maxWidth);
  }
  return clipped;
}

function filterDrawable(font: BitmapFont, text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (hasGlyph(font, cp)) out += ch;
    else if (ch === ' ') out += ch;
  }
  return out;
}

function ellipsize(font: BitmapFont, text: string, maxWidth: number): string {
  const ell = hasGlyph(font, 0x2026) ? '…' : '.';
  let s = text;
  while (s.length > 0 && textWidth(font, `${s}${ell}`) > maxWidth) {
    s = s.slice(0, -1);
  }
  return `${s}${ell}`;
}

function splitHistoryLine(line: string): { year: string | null; text: string } {
  const m = line.match(/^(\d{1,4})\s*[·.-]\s*(.+)$/);
  if (!m) return { year: null, text: line };
  return { year: m[1]!, text: m[2]! };
}

function formatDatePart(
  date: Date,
  mode: 'year' | 'monthDay' | 'cnMonthDay',
  timeZone: string
): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  if (mode === 'year') return year;
  if (mode === 'cnMonthDay') return `${Number(month)} 月 ${Number(day)} 日`;
  return `${month}/${day}`;
}

function formatShortTime(value: unknown, fallback: Date, timeZone: string): string {
  let date = fallback;
  if (typeof value === 'string') {
    date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    }
  }
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function timezoneFromConfig(config: Record<string, unknown>): string {
  const tz = config.tz;
  return typeof tz === 'string' && tz.trim() ? tz : 'UTC';
}

function normalizeWeatherCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function formatLabel(key: string): string {
  const map: Record<string, string> = {
    today: '今日',
    yesterday: '昨日',
    this_week: '本周',
    this_month: '本月',
  };
  return map[key] ?? key.replace(/_/g, ' ');
}
