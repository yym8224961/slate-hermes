import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FRAME_BYTES, FRAME_HEIGHT, FRAME_WIDTH, type FontTestFontIdT } from 'shared';
import { BITMAP_1BPP_FONT_DIR } from '../../infra/assets/asset-paths';
import { traditionalFestivalShortName } from '../dynamic-content/traditional-festivals';
import { timezoneFromConfig } from '../dynamic-content/timezone';
import { BitmapCanvas, PIXEL_BLACK, PIXEL_WHITE } from './bitmap-canvas';
import { DEVICE_FONT_CATALOG, DEVICE_FONT_IDS, getDeviceFontEntry } from './font-catalog';
import { hasGlyph, loadBitmapFont, textWidth, type BitmapFont } from './bitmap-font';

export interface DynamicRenderContext {
  type: string;
  frameName?: string | null;
  config: Record<string, unknown>;
  data: Record<string, unknown> | null;
  renderedAt: Date;
}

interface FontSet {
  sans16: BitmapFont;
  sans12: BitmapFont;
  display48: BitmapFont;
  catalog: Partial<Record<string, BitmapFont>>;
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
      sans12: await loadBitmapFont(resolveFontPath('noto-sans-sc-12.json')),
      display48: await loadBitmapFont(resolveFontPath('montserrat-48.json')),
      catalog: await loadDeviceFontCatalog(),
    };
  }

  async render(ctx: DynamicRenderContext): Promise<Buffer> {
    const fonts = await this.getFonts();
    const c = new BitmapCanvas(FRAME_WIDTH, FRAME_HEIGHT);
    c.clear(PIXEL_WHITE);
    this.clearSystemStatusArea(c);

    switch (ctx.type) {
      case 'daily_calendar':
        this.renderDate(c, fonts, ctx);
        break;
      case 'month_calendar':
        this.renderMonthCalendar(c, fonts, ctx);
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
      case 'font_test':
        this.renderFontTest(c, fonts, ctx);
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
      sans12: await loadBitmapFont(resolveFontPath('noto-sans-sc-12.json')),
      display48: await loadBitmapFont(resolveFontPath('montserrat-48.json')),
      catalog: await loadDeviceFontCatalog(),
    };
    return this.fonts;
  }

  private clearSystemStatusArea(c: BitmapCanvas): void {
    c.fillRect(0, 0, FRAME_WIDTH, STATUS_BAR_H, PIXEL_WHITE);
  }

  private renderDate(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const data = ctx.data ?? {};
    const tz = timezoneFromConfig(ctx.config);
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
    const festival = traditionalFestivalShortName(pickText(data.festival, ''));
    const nextSolarTermDays =
      typeof data.nextSolarTermDays === 'number' && Number.isFinite(data.nextSolarTermDays)
        ? data.nextSolarTermDays
        : null;
    const yi = readStringArray(data.yi).slice(0, 5).join(' ');
    const ji = readStringArray(data.ji).slice(0, 5).join(' ');
    const monthDay = `${pad2(Number(month))}/${pad2(Number(day))}`;
    const term = solarTerm || nextSolarTerm;
    const daysLabel =
      nextSolarTermDays === null
        ? ''
        : nextSolarTermDays === 0
          ? '今天'
          : `${nextSolarTermDays}天后`;

    const topY = 42;
    const rightX = 228;
    this.drawText(c, fonts.display48, monthDay, CONTENT_LEFT, topY + 8, {
      maxWidth: 172,
      ellipsis: true,
    });
    this.drawText(c, fonts.sans16, weekday || '今日', rightX, topY + 8, {
      maxWidth: CONTENT_RIGHT - rightX,
      ellipsis: true,
    });
    if (lunarDate) {
      this.drawText(c, fonts.sans16, lunarDate, rightX, topY + 39, {
        maxWidth: CONTENT_RIGHT - rightX,
        ellipsis: true,
      });
    }
    if (ganzhi) {
      this.drawText(c, fonts.sans16, ganzhi, rightX, topY + 72, {
        maxWidth: CONTENT_RIGHT - rightX,
        maxLines: 1,
        ellipsis: true,
      });
    }
    this.drawRule(c, CONTENT_LEFT, 170, CONTENT_WIDTH, 'dashed');

    const rows: Array<[string, string]> = [];
    if (solarTerm) rows.push(['今日节气', daysLabel ? `${solarTerm} ${daysLabel}` : solarTerm]);
    else if (festival) rows.push(['今日节日', festival]);
    else if (term) rows.push(['下个节气', daysLabel ? `${term} ${daysLabel}` : term]);
    else if (ganzhi) rows.push(['干支', ganzhi]);
    rows.slice(0, 1).forEach(([label, value], index) => {
      this.drawInfoRow(c, fonts, label, value, CONTENT_LEFT, 184 + index * 27, CONTENT_WIDTH);
    });
    if (yi) this.drawLabeledText(c, fonts, '宜', yi, CONTENT_LEFT, 215, CONTENT_WIDTH);
    if (ji) this.drawLabeledText(c, fonts, '忌', ji, CONTENT_LEFT, 243, CONTENT_WIDTH);
  }

  private renderMonthCalendar(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const tz = timezoneFromConfig(ctx.config);
    const parts = dateParts(ctx.renderedAt, tz);
    const monthKey = `${parts.year}-${pad2(parts.month)}`;
    const days = getPath(ctx.data, `calendar.months.${monthKey}.days`);
    const first = weekdayFor(parts.year, parts.month, 1);
    const total = daysInMonth(parts.year, parts.month);

    const x0 = 14;
    const y0 = 32;
    const w = FRAME_WIDTH - 28;
    const colW = Math.floor(w / 7);
    const headerH = 24;
    const weekRows = Math.ceil((first + total) / 7);
    const rowH =
      weekRows > 1 ? Math.floor((FRAME_HEIGHT - (y0 + headerH) - 38) / (weekRows - 1)) : 42;

    const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

    for (let i = 0; i < 7; i++) {
      const label = WEEKDAY_SHORT[i];
      const cx = x0 + i * colW + Math.floor(colW / 2);
      this.drawText(c, fonts.sans16, label, cx, y0, {
        align: 'center',
        maxWidth: colW,
      });
    }

    for (let day = 1; day <= total; day++) {
      const pos = first + day - 1;
      const col = pos % 7;
      const row = Math.floor(pos / 7);
      const x = x0 + col * colW;
      const y = y0 + headerH + row * rowH;
      const isToday = day === parts.day;

      if (isToday) {
        c.fillRect(x + Math.floor(colW / 2) - 11, y + 1, 22, 18, PIXEL_BLACK);
      }

      this.drawText(c, fonts.sans16, String(day), x + Math.floor(colW / 2), y + 2, {
        align: 'center',
        maxWidth: colW - 4,
        color: isToday ? PIXEL_WHITE : PIXEL_BLACK,
      });

      const iso = `${parts.year}-${pad2(parts.month)}-${pad2(day)}`;
      const dayData = isRecord(days) ? days[iso] : null;
      const sub = monthCellSubtitle(dayData, ctx.config);
      if (sub) {
        this.drawText(c, fonts.sans12, sub, x + Math.floor(colW / 2), y + 15, {
          align: 'center',
          maxWidth: colW - 2,
          color: PIXEL_BLACK,
          ellipsis: true,
        });
      }
    }
  }

  private renderWeather(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const data = ctx.data ?? {};
    const temp = pickText(data.tempC, pickText(data.temp, '--'));
    const feelsLike = pickText(data.feelsLikeC, pickText(data.feelsLike, ''));
    const humidity = pickText(data.humidity, '--');
    const wind = pickText(data.windDisplay, pickText(data.wind, '--'));
    const fc = Array.isArray(data.fc) ? data.fc.slice(0, 3) : [];

    this.drawWeatherIcon(c, normalizeWeatherCode(data.code), 92, 92, 'large');
    this.drawText(c, fonts.display48, temp, 148, 45, {
      maxWidth: 110,
      ellipsis: true,
    });
    this.drawText(
      c,
      fonts.sans16,
      '°',
      148 + Math.min(104, textWidth(fonts.display48, temp) + 6),
      52,
      {
        maxWidth: 20,
      }
    );

    this.drawText(c, fonts.sans16, feelsLike ? `体感 ${feelsLike}°` : '体感 --', 274, 66, {
      maxWidth: 96,
      ellipsis: true,
    });
    this.drawText(c, fonts.sans16, humidity === '--' ? '湿度 --' : `湿度 ${humidity}%`, 274, 96, {
      maxWidth: 96,
      ellipsis: true,
    });
    this.drawText(c, fonts.sans16, wind, 274, 126, {
      maxWidth: 96,
      ellipsis: true,
    });

    this.drawRule(c, CONTENT_LEFT, 166, CONTENT_WIDTH, 'dashed');
    const forecast = fc.length > 0 ? fc : [null, null, null];
    const colW = Math.floor(CONTENT_WIDTH / 3);
    forecast.slice(0, 3).forEach((item, index) => {
      const record = isRecord(item) ? item : {};
      const x = CONTENT_LEFT + index * colW;
      if (index > 0) this.drawVRule(c, x, 178, 104, 'dashed');
      const label = pickText(record.label, ['今日', '明日', '后天'][index] ?? '');
      const text = pickText(record.text, forecastTextFromVal(record.val));
      const min = pickText(record.tempMin, '');
      const max = pickText(record.tempMax, '');
      const range = min && max ? `${min}~${max}°` : forecastRangeFromVal(record.val);
      const center = Math.round(x + colW / 2);
      this.drawText(c, fonts.sans16, label, center, 180, {
        align: 'center',
        maxWidth: colW - 12,
        ellipsis: true,
      });
      this.drawWeatherIcon(c, normalizeWeatherCode(record.code), center, 214, 'tiny');
      this.drawForecastRange(c, fonts, range || '--', center, 242, colW - 12);
      this.drawText(c, fonts.sans16, text || '--', center, 266, {
        align: 'center',
        maxWidth: colW - 12,
        ellipsis: true,
      });
    });
  }

  private renderHistoryToday(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const data = ctx.data ?? {};
    const lines = [data.line0, data.line1, data.line2, data.line3]
      .map((v) => pickText(v, ''))
      .filter((v) => v.length > 0);
    const source = lines.length > 0 ? lines : [FALLBACK_TEXT];
    let y = 42;
    for (const line of source.slice(0, 4)) {
      const split = splitHistoryLine(line);
      if (split.year) {
        this.drawText(c, fonts.sans12, split.year, CONTENT_LEFT, y, { maxWidth: 42 });
        c.drawVLine(CONTENT_LEFT + 52, y + 1, 42, PIXEL_BLACK);
        this.drawText(c, fonts.sans12, split.text, CONTENT_LEFT + 68, y, {
          maxWidth: CONTENT_WIDTH - 68,
          maxLines: 2,
          ellipsis: true,
          lineGap: 0,
        });
      } else {
        this.drawText(c, fonts.sans12, split.text, CONTENT_LEFT, y, {
          maxWidth: CONTENT_WIDTH,
          maxLines: 2,
          ellipsis: true,
          lineGap: 0,
        });
      }
      y += 61;
    }
  }

  private renderDashboard(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const data = ctx.data ?? {};
    if (isRecord(data.layout) && Array.isArray(data.layout.blocks)) {
      this.renderDashboardLayout(c, fonts, ctx, data.layout);
      return;
    }

    const metrics = isRecord(data.metrics) ? Object.entries(data.metrics).slice(0, 4) : [];
    const heading = pickText(data.heading, pickText(data.title, ctx.frameName ?? '数据看板'));
    const subtitle = pickText(data.subtitle, '');

    this.drawText(c, fonts.sans16, heading, CONTENT_LEFT, CONTENT_TOP + 2, {
      maxWidth: 220,
      ellipsis: true,
    });
    this.drawText(
      c,
      fonts.sans12,
      formatShortTime(data.updated_at, ctx.renderedAt, timezoneFromConfig(ctx.config)),
      CONTENT_RIGHT,
      CONTENT_TOP + 2,
      {
        align: 'right',
        maxWidth: 110,
        ellipsis: true,
      }
    );
    if (subtitle) {
      this.drawText(c, fonts.sans12, subtitle, CONTENT_LEFT, 58, {
        maxWidth: CONTENT_WIDTH,
        ellipsis: true,
      });
    }
    this.drawRule(c, CONTENT_LEFT, subtitle ? 82 : 66, CONTENT_WIDTH, 'solid');

    if (metrics.length === 0) {
      this.drawText(c, fonts.sans16, '等待数据推送', 200, 145, { align: 'center' });
      this.drawText(c, fonts.sans12, 'POST /contents/:id/data', 200, 170, { align: 'center' });
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

  private renderFontTest(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const fontId = readFontId(ctx.config.font_id);
    const entry = getDeviceFontEntry(fontId);
    const sampleFont = fonts.catalog[entry.id] ?? fonts.sans16;
    const layout = entry.kind === 'icon' ? 'icons' : readFontTestLayout(ctx.config.layout);
    const invert = ctx.config.invert === true;
    const data = ctx.data ?? {};
    const sample = pickText(data.sampleText, pickText(ctx.config.sample_text, entry.sampleText));
    const header = pickText(data.fontLabel, entry.label);
    const meta = `${entry.hint} · ${sampleFont.lineHeight}px line · ${sampleFont.glyphs.size} glyphs`;
    const missing = missingGlyphs(sampleFont, sample);

    if (invert) {
      c.fillRect(0, STATUS_BAR_H, FRAME_WIDTH, FRAME_HEIGHT - STATUS_BAR_H, PIXEL_BLACK);
    }
    const fg = invert ? PIXEL_WHITE : PIXEL_BLACK;
    const bg = invert ? PIXEL_BLACK : PIXEL_WHITE;

    this.drawText(c, fonts.sans16, header, CONTENT_LEFT, 35, {
      maxWidth: 220,
      ellipsis: true,
      color: fg,
    });
    this.drawText(c, fonts.sans12, meta, CONTENT_RIGHT, 37, {
      align: 'right',
      maxWidth: 128,
      ellipsis: true,
      color: fg,
    });
    this.drawRuleColor(c, CONTENT_LEFT, 62, CONTENT_WIDTH, 'solid', fg);

    if (layout === 'icons') {
      this.renderFontIcons(c, fonts, sampleFont, sample, fg);
    } else if (layout === 'numbers') {
      this.renderFontNumbers(c, fonts, sampleFont, fg);
    } else if (layout === 'paragraph') {
      this.renderFontParagraph(c, fonts, sampleFont, sample, fg);
    } else {
      this.renderFontSpecimen(c, fonts, sampleFont, sample, fg, bg);
    }

    const footer = missing.length
      ? `缺字: ${missing.slice(0, 10).join('')}${missing.length > 10 ? '…' : ''}`
      : pickText(data.note, `${entry.note} · ${entry.source} · ${entry.license}`);
    this.drawRuleColor(c, CONTENT_LEFT, 269, CONTENT_WIDTH, 'dashed', fg);
    this.drawText(c, fonts.sans12, footer, CONTENT_LEFT, 276, {
      maxWidth: CONTENT_WIDTH,
      ellipsis: true,
      color: fg,
    });
  }

  private renderFontSpecimen(
    c: BitmapCanvas,
    fonts: FontSet,
    sampleFont: BitmapFont,
    sample: string,
    fg: number,
    bg: number
  ): void {
    const blockY = 78;
    c.strokeRect(CONTENT_LEFT, blockY, CONTENT_WIDTH, 92, fg);
    if (bg === PIXEL_BLACK) c.fillRect(CONTENT_LEFT + 1, blockY + 1, CONTENT_WIDTH - 2, 90, bg);
    this.drawText(c, sampleFont, sample, CONTENT_LEFT + 12, blockY + 10, {
      maxWidth: CONTENT_WIDTH - 24,
      maxLines: sampleFont.lineHeight <= 16 ? 4 : 2,
      ellipsis: true,
      lineGap: 2,
      color: fg,
    });

    const rows: Array<[string, string]> = [
      ['数字', '0123456789 100% --'],
      ['拉丁', 'ABC abc Slate UI'],
      ['中文', '墨水屏 字体 渲染'],
    ];
    rows.forEach(([label, text], index) => {
      const y = 188 + index * 24;
      this.drawText(c, fonts.sans12, label, CONTENT_LEFT, y + 1, { maxWidth: 34, color: fg });
      this.drawText(c, sampleFont, text, CONTENT_LEFT + 46, y, {
        maxWidth: CONTENT_WIDTH - 46,
        ellipsis: true,
        color: fg,
      });
    });
  }

  private renderFontParagraph(
    c: BitmapCanvas,
    fonts: FontSet,
    sampleFont: BitmapFont,
    sample: string,
    fg: number
  ): void {
    this.drawText(c, sampleFont, sample, CONTENT_LEFT, 78, {
      maxWidth: CONTENT_WIDTH,
      maxLines: Math.max(2, Math.floor(168 / (sampleFont.lineHeight + 3))),
      ellipsis: true,
      lineGap: 3,
      color: fg,
    });
    this.drawRuleColor(c, CONTENT_LEFT, 240, CONTENT_WIDTH, 'dashed', fg);
    this.drawText(c, fonts.sans12, '基线 / 字距 / 换行检查', CONTENT_LEFT, 250, {
      maxWidth: CONTENT_WIDTH,
      color: fg,
    });
  }

  private renderFontNumbers(
    c: BitmapCanvas,
    fonts: FontSet,
    sampleFont: BitmapFont,
    fg: number
  ): void {
    const rows = ['0123456789', '23:59 100%', '+12.8 -04', '¥128.00'];
    rows.forEach((line, index) => {
      const y = 76 + index * 42;
      this.drawText(c, sampleFont, line, 200, y, {
        align: 'center',
        maxWidth: CONTENT_WIDTH,
        ellipsis: true,
        color: fg,
      });
      this.drawRuleColor(c, 64, y + sampleFont.lineHeight + 5, 272, 'dashed', fg);
    });
    this.drawText(c, fonts.sans12, '居中数字、冒号、百分号和货币符号', 200, 246, {
      align: 'center',
      maxWidth: CONTENT_WIDTH,
      color: fg,
    });
  }

  private renderFontIcons(
    c: BitmapCanvas,
    fonts: FontSet,
    sampleFont: BitmapFont,
    sample: string,
    fg: number
  ): void {
    const icons = Array.from(sample).filter((ch) => ch.trim().length > 0);
    const cols = sampleFont.lineHeight >= 24 ? 8 : 12;
    const cellW = Math.floor(CONTENT_WIDTH / cols);
    const cellH = sampleFont.lineHeight >= 24 ? 48 : 34;
    icons.slice(0, cols * 4).forEach((icon, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = CONTENT_LEFT + col * cellW;
      const y = 77 + row * cellH;
      if (col > 0) this.drawVRule(c, x, y, cellH - 8, 'dashed');
      this.drawText(c, sampleFont, icon, x + Math.floor(cellW / 2), y + 2, {
        align: 'center',
        maxWidth: cellW,
        color: fg,
      });
    });
    this.drawRuleColor(c, CONTENT_LEFT, 238, CONTENT_WIDTH, 'dashed', fg);
    this.drawText(c, fonts.sans12, '图标字形、间距和基线检查', CONTENT_LEFT, 248, {
      maxWidth: CONTENT_WIDTH,
      color: fg,
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
    const heading = pickText(
      layout.heading,
      pickText(
        layout.title,
        pickText(ctx.data?.heading, pickText(ctx.data?.title, ctx.frameName ?? '数据看板'))
      )
    );
    if (heading) {
      this.drawText(c, fonts.sans16, heading, CONTENT_LEFT, 34, { maxWidth: 220, ellipsis: true });
    }
    const blocks = Array.isArray(layout.blocks) ? layout.blocks.slice(0, 24) : [];
    for (const rawBlock of blocks) {
      if (!isRecord(rawBlock)) continue;
      const type = pickText(rawBlock.type, '');
      if (type === 'text') {
        const rect = blockRect(rawBlock);
        if (!rect) continue;
        const font = rawBlock.size === 'sm' ? fonts.sans12 : fonts.sans16;
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
    const boxW = 24;
    const boxH = 21;
    c.strokeRect(x, y, boxW, boxH, PIXEL_BLACK);
    this.drawText(c, fonts.sans12, label, x + Math.floor(boxW / 2), y - 1, {
      align: 'center',
      maxWidth: boxW - 4,
    });
    this.drawText(c, fonts.sans16, value, x + boxW + 12, y + 3, {
      maxWidth: w - boxW - 12,
      ellipsis: true,
    });
  }

  private drawForecastRange(
    c: BitmapCanvas,
    fonts: FontSet,
    value: string,
    centerX: number,
    y: number,
    maxWidth: number
  ): void {
    const m = value.match(/^(.+?)[~～](.+)$/);
    if (!m) {
      this.drawText(c, fonts.sans16, value, centerX, y, {
        align: 'center',
        maxWidth,
        ellipsis: true,
      });
      return;
    }

    const left = m[1]!;
    const right = m[2]!;
    const waveW = 9;
    const gap = 3;
    const totalW =
      textWidth(fonts.sans16, left) + gap + waveW + gap + textWidth(fonts.sans16, right);
    if (totalW > maxWidth) {
      this.drawText(c, fonts.sans16, `${left}-${right}`, centerX, y, {
        align: 'center',
        maxWidth,
        ellipsis: true,
      });
      return;
    }

    const startX = Math.round(centerX - totalW / 2);
    this.drawText(c, fonts.sans16, left, startX, y);
    const waveX = startX + textWidth(fonts.sans16, left) + gap;
    this.drawCenteredWave(c, waveX, y + 9);
    this.drawText(c, fonts.sans16, right, waveX + waveW + gap, y);
  }

  private drawCenteredWave(c: BitmapCanvas, x: number, y: number): void {
    c.drawLine(x, y + 1, x + 2, y - 1, PIXEL_BLACK);
    c.drawLine(x + 2, y - 1, x + 5, y + 1, PIXEL_BLACK);
    c.drawLine(x + 5, y + 1, x + 8, y - 1, PIXEL_BLACK);
  }

  private drawInfoRow(
    c: BitmapCanvas,
    fonts: FontSet,
    label: string,
    value: string,
    x: number,
    y: number,
    w: number
  ): void {
    const labelText = `${label}:`;
    const labelW = Math.min(94, Math.max(24, textWidth(fonts.sans16, labelText) + 4));
    this.drawText(c, fonts.sans16, labelText, x, y + 1, {
      maxWidth: labelW,
    });
    this.drawText(c, fonts.sans16, value, x + labelW + 8, y + 1, {
      maxWidth: w - labelW - 8,
      ellipsis: true,
    });
  }

  private drawMetricStrip(c: BitmapCanvas, fonts: FontSet, items: Array<[string, string]>): void {
    const y = 160;
    const colW = Math.floor(CONTENT_WIDTH / items.length);
    items.forEach(([label, value], index) => {
      const x = CONTENT_LEFT + index * colW;
      if (index > 0) c.drawVLine(x - 5, y - 2, 22, PIXEL_BLACK);
      this.drawText(c, fonts.sans12, label, x, y - 1, { maxWidth: 32, ellipsis: true });
      this.drawText(c, fonts.sans12, value, x + 39, y - 1, {
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

  private drawRuleColor(
    c: BitmapCanvas,
    x: number,
    y: number,
    w: number,
    style: 'solid' | 'dashed',
    color: number
  ): void {
    if (style === 'solid') {
      c.drawHLine(x, y, w, color);
      return;
    }
    for (let xx = 0; xx < w; xx += 8) c.drawHLine(x + xx, y, Math.min(4, w - xx), color);
  }

  private drawVRule(
    c: BitmapCanvas,
    x: number,
    y: number,
    h: number,
    style: 'solid' | 'dashed'
  ): void {
    if (style === 'solid') {
      c.drawVLine(x, y, h, PIXEL_BLACK);
      return;
    }
    for (let yy = 0; yy < h; yy += 8) c.drawVLine(x, y + yy, Math.min(4, h - yy), PIXEL_BLACK);
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
    this.drawText(c, fonts.sans12, label, x + 7, y + 4, { maxWidth: w - 14, ellipsis: true });
    this.drawText(c, fonts.sans16, value, x + 7, y + 32, { maxWidth: w - 14, ellipsis: true });
    if (series.length >= 2 && h >= 54) {
      this.drawSparkline(c, x + 7, y + h - 18, w - 14, 10, series);
    }
  }

  private drawWeatherIcon(
    c: BitmapCanvas,
    code: number | null,
    cx: number,
    cy: number,
    size: 'tiny' | 'small' | 'large' = 'large'
  ): void {
    const scale = size === 'large' ? 2.1 : size === 'small' ? 1.35 : 1.15;
    if (code !== null && isRainCode(code)) {
      this.drawCloudIcon(c, cx, cy - Math.round(3 * scale), scale);
      this.drawRainIcon(c, cx, cy + Math.round(15 * scale), scale);
      return;
    }
    if (code !== null && isSnowCode(code)) {
      this.drawCloudIcon(c, cx, cy - Math.round(3 * scale), scale);
      this.drawSnowIcon(c, cx, cy + Math.round(15 * scale), scale);
      return;
    }
    if (code !== null && isFogCode(code)) {
      this.drawFogIcon(c, cx, cy, scale);
      return;
    }
    if (code !== null && isPartlyCloudyCode(code)) {
      this.drawSunIcon(c, cx - Math.round(7 * scale), cy - Math.round(5 * scale), scale * 0.74);
      this.drawCloudIcon(c, cx + Math.round(4 * scale), cy + Math.round(4 * scale), scale * 0.88);
      return;
    }
    if (code !== null && isCloudyCode(code)) {
      this.drawCloudIcon(c, cx, cy, scale);
      return;
    }
    this.drawSunIcon(c, cx, cy, scale);
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

  private drawSunIcon(c: BitmapCanvas, cx: number, cy: number, scale: number): void {
    const r = Math.max(5, Math.round(6 * scale));
    const ray0 = Math.round(10 * scale);
    const ray1 = Math.round(15 * scale);
    c.strokeCircle(cx, cy, r, PIXEL_BLACK);
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 * i) / 8;
      c.drawLine(
        Math.round(cx + Math.cos(angle) * ray0),
        Math.round(cy + Math.sin(angle) * ray0),
        Math.round(cx + Math.cos(angle) * ray1),
        Math.round(cy + Math.sin(angle) * ray1),
        PIXEL_BLACK
      );
    }
  }

  private drawCloudIcon(c: BitmapCanvas, cx: number, cy: number, scale: number): void {
    const sx = (n: number) => Math.round(n * scale);
    const left = cx - sx(17);
    const right = cx + sx(18);
    const base = cy + sx(10);
    c.drawLine(left, base, right, base, PIXEL_BLACK);
    c.drawLine(left, base, left - sx(5), base - sx(4), PIXEL_BLACK);
    c.drawLine(right, base, right + sx(5), base - sx(4), PIXEL_BLACK);
    this.drawArc(c, left - sx(1), base - sx(4), sx(8), Math.PI, Math.PI * 1.53);
    this.drawArc(c, cx - sx(3), base - sx(8), sx(11), Math.PI * 1.18, Math.PI * 1.96);
    this.drawArc(c, cx + sx(14), base - sx(4), sx(8), Math.PI * 1.43, Math.PI * 2.04);
  }

  private drawRainIcon(c: BitmapCanvas, cx: number, cy: number, scale: number): void {
    for (const offset of [-9, 0, 9]) {
      const x = cx + Math.round(offset * scale);
      c.drawLine(
        x,
        cy - Math.round(3 * scale),
        x - Math.round(3 * scale),
        cy + Math.round(5 * scale),
        PIXEL_BLACK
      );
    }
  }

  private drawSnowIcon(c: BitmapCanvas, cx: number, cy: number, scale: number): void {
    for (const offset of [-8, 8]) {
      const x = cx + Math.round(offset * scale);
      const r = Math.max(3, Math.round(4 * scale));
      c.drawHLine(x - r, cy, r * 2 + 1, PIXEL_BLACK);
      c.drawVLine(x, cy - r, r * 2 + 1, PIXEL_BLACK);
    }
  }

  private drawFogIcon(c: BitmapCanvas, cx: number, cy: number, scale: number): void {
    const w = Math.round(30 * scale);
    for (let i = 0; i < 4; i++) {
      c.drawHLine(
        cx - Math.floor(w / 2),
        cy - Math.round(12 * scale) + i * Math.round(8 * scale),
        w,
        PIXEL_BLACK
      );
    }
  }

  private drawArc(
    c: BitmapCanvas,
    cx: number,
    cy: number,
    r: number,
    start: number,
    end: number
  ): void {
    const steps = Math.max(8, Math.ceil((Math.abs(end - start) * r) / 2));
    let px = Math.round(cx + Math.cos(start) * r);
    let py = Math.round(cy + Math.sin(start) * r);
    for (let i = 1; i <= steps; i++) {
      const angle = start + ((end - start) * i) / steps;
      const x = Math.round(cx + Math.cos(angle) * r);
      const y = Math.round(cy + Math.sin(angle) * r);
      c.drawLine(px, py, x, y, PIXEL_BLACK);
      px = x;
      py = y;
    }
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
    resolve(BITMAP_1BPP_FONT_DIR, file),
    resolve(process.cwd(), 'assets', 'fonts', 'bitmap-1bpp', file),
    resolve(process.cwd(), 'backend', 'assets', 'fonts', 'bitmap-1bpp', file),
    resolve(process.cwd(), '..', 'backend', 'assets', 'fonts', 'bitmap-1bpp', file),
    join(import.meta.dir, '..', '..', '..', 'assets', 'fonts', 'bitmap-1bpp', file),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`device font not found: ${file}`);
  return found;
}

async function loadDeviceFontCatalog(): Promise<Partial<Record<string, BitmapFont>>> {
  const out: Partial<Record<string, BitmapFont>> = {};
  await Promise.all(
    DEVICE_FONT_CATALOG.map(async (entry) => {
      out[entry.id] = await loadBitmapFont(resolveFontPath(entry.file));
    })
  );
  return out;
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

function readFontId(value: unknown): FontTestFontIdT {
  return typeof value === 'string' && DEVICE_FONT_IDS.has(value as FontTestFontIdT)
    ? (value as FontTestFontIdT)
    : 'fusion_pixel_12';
}

function readFontTestLayout(value: unknown): 'specimen' | 'paragraph' | 'numbers' | 'icons' {
  return value === 'paragraph' || value === 'numbers' || value === 'icons' ? value : 'specimen';
}

function missingGlyphs(font: BitmapFont, text: string): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const ch of text) {
    if (ch === ' ' || ch === '\n') continue;
    if (hasGlyph(font, ch.codePointAt(0)!)) continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    missing.push(ch);
  }
  return missing;
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

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function weekdayFor(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return {
    year: Number(parts.find((p) => p.type === 'year')?.value ?? 1970),
    month: Number(parts.find((p) => p.type === 'month')?.value ?? 1),
    day: Number(parts.find((p) => p.type === 'day')?.value ?? 1),
  };
}

function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function monthCellSubtitle(dayData: unknown, config: Record<string, unknown>): string {
  if (!isRecord(dayData)) return '';
  void config;
  const term = pickText(dayData.solar_term, '');
  if (term) return limitChars(term, 3);
  const festival = traditionalFestivalShortName(pickText(dayData.festival, ''));
  if (festival) return festival;
  return simplifyLunar(pickText(dayData.lunar_date, pickText(dayData.lunar, '')));
}

function simplifyLunar(value: string): string {
  const cleaned = value
    .replace(/^农历/, '')
    .replace(/^[甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥]+年\s*/, '');
  const m = cleaned.match(/^(闰?[正一二三四五六七八九十冬腊]+)月(.+)$/);
  if (!m) return limitChars(cleaned, 3);
  const month = m[1]!;
  const day = m[2]!;
  return day === '初一' ? `${month}月` : day;
}

function limitChars(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('');
}
