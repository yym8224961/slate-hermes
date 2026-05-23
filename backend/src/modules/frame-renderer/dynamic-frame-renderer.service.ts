import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  FRAME_BYTES,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  ICON_FONT_TEST_SAMPLE,
  type FontTestFontIdT,
} from 'shared';
import { BITMAP_1BPP_FONT_DIR } from '../../infra/assets/asset-paths';
import { traditionalFestivalShortName } from '../dynamic-content/traditional-festivals';
import { timezoneFromConfig } from '../dynamic-content/timezone';
import { parseHistoryTodayData } from '../dynamic-content/history-today.data';
import { BitmapCanvas, PIXEL_BLACK, PIXEL_WHITE, type BitmapMask } from './bitmap-canvas';
import {
  DEVICE_FONT_CATALOG,
  DEVICE_FONT_IDS,
  getDeviceFontEntry,
  type DeviceFontCatalogEntry,
} from './font-catalog';
import { hasGlyph, loadBitmapFont, textWidth, type BitmapFont } from './bitmap-font';
import { loadWeatherIconMask } from './weather-icons';

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
  calendarSub10: BitmapFont;
  metric12: BitmapFont;
  fallback16: BitmapFont;
  displayLarge: BitmapFont;
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

interface FontSpecimen {
  hero: string;
  body: string[];
  metrics: string[];
  glyphs: string[];
}

const STATUS_BAR_H = 24;
const CONTENT_TOP = STATUS_BAR_H + 10;
const CONTENT_SAFE_TOP = STATUS_BAR_H;
const CONTENT_SAFE_BOTTOM = FRAME_HEIGHT;
const CONTENT_LEFT = 20;
const CONTENT_RIGHT = FRAME_WIDTH - 20;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const FALLBACK_TEXT = '暂无数据';
const HOT_LIST_RENDER_COUNT = 8;

@Injectable()
export class DynamicFrameRendererService implements OnModuleInit {
  private fonts: FontSet | null = null;

  async onModuleInit(): Promise<void> {
    await this.getFonts();
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
        await this.renderWeather(c, fonts, ctx);
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
      case 'hot_list':
        this.renderHotList(c, fonts, ctx);
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
    const fusionPixel10 = await loadBitmapFont(resolveFontPath('fusion-pixel-10.json'));
    this.fonts = {
      sans16: await loadBitmapFont(resolveFontPath('source-han-sans-16-slim.json')),
      sans12: fusionPixel10,
      calendarSub10: fusionPixel10,
      metric12: await loadBitmapFont(resolveFontPath('pixelmplus-12.json')),
      fallback16: await loadBitmapFont(resolveFontPath('unifont-16.json')),
      displayLarge: await loadBitmapFont(resolveFontPath('spleen-32x64.json')),
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
      .join(' ');
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

    const ruleY = Math.round((CONTENT_SAFE_TOP + CONTENT_SAFE_BOTTOM) / 2);
    const upperTop = CONTENT_SAFE_TOP + 18;
    const upperBottom = ruleY - 16;
    const dateY =
      upperTop + Math.round((upperBottom - upperTop - fonts.displayLarge.lineHeight) / 2);
    const rightY =
      upperTop + Math.round((upperBottom - upperTop - (fonts.sans16.lineHeight * 3 + 14 * 2)) / 2);
    const dateX = 18;
    const rightX = 202;
    this.drawText(c, fonts.displayLarge, monthDay, dateX, dateY, {
      maxWidth: 176,
      ellipsis: true,
    });
    this.drawText(c, fonts.sans16, weekday || '今日', rightX, rightY, {
      maxWidth: CONTENT_RIGHT - rightX,
      ellipsis: true,
    });
    if (lunarDate) {
      this.drawText(c, fonts.sans16, lunarDate, rightX, rightY + 30, {
        maxWidth: CONTENT_RIGHT - rightX,
        ellipsis: true,
      });
    }
    if (ganzhi) {
      this.drawText(c, fonts.sans16, ganzhi, rightX, rightY + 60, {
        maxWidth: CONTENT_RIGHT - rightX,
        maxLines: 1,
        ellipsis: true,
      });
    }
    this.drawRule(c, CONTENT_LEFT, ruleY, CONTENT_WIDTH, 'dashed');

    const infoRow: [string, string] | null = solarTerm
      ? ['今日节气', daysLabel ? `${solarTerm} ${daysLabel}` : solarTerm]
      : festival
        ? ['今日节日', festival]
        : term
          ? ['下个节气', daysLabel ? `${term} ${daysLabel}` : term]
          : ganzhi
            ? ['干支', ganzhi]
            : null;
    const infoY = ruleY + 20;
    const yiY = ruleY + 56;
    const jiY = ruleY + 98;
    if (infoRow) {
      this.drawInfoRow(c, fonts, infoRow[0], infoRow[1], CONTENT_LEFT, infoY, CONTENT_WIDTH);
    }
    if (yi) this.drawLabeledText(c, fonts, '宜', yi, CONTENT_LEFT, yiY, CONTENT_WIDTH);
    if (ji) this.drawLabeledText(c, fonts, '忌', ji, CONTENT_LEFT, jiY, CONTENT_WIDTH);
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
      const sub = monthCellSubtitle(dayData);
      if (sub) {
        this.drawText(c, fonts.calendarSub10, sub, x + Math.floor(colW / 2), y + 15, {
          align: 'center',
          maxWidth: colW - 2,
          color: PIXEL_BLACK,
          ellipsis: true,
        });
      }
    }
  }

  private async renderWeather(
    c: BitmapCanvas,
    fonts: FontSet,
    ctx: DynamicRenderContext
  ): Promise<void> {
    const data = ctx.data ?? {};
    const temp = pickText(data.tempC, pickText(data.temp, '--'));
    const feelsLike = pickText(data.feelsLikeC, pickText(data.feelsLike, ''));
    const humidity = pickText(data.humidity, '--');
    const wind = pickText(data.windDisplay, pickText(data.wind, '--'));
    const fc = Array.isArray(data.fc) ? data.fc.slice(0, 3) : [];

    const forecastTop = CONTENT_SAFE_TOP + 132;
    const heroTop = CONTENT_SAFE_TOP;
    const heroBottom = forecastTop;
    const heroCenterY = Math.round((heroTop + heroBottom) / 2);
    const leftAreaX = CONTENT_LEFT;
    const leftAreaW = 232;
    const halfW = Math.floor(leftAreaW / 2);
    const iconCx = leftAreaX + Math.round(halfW / 2);
    const iconCy = heroCenterY;
    const tempCenterX = leftAreaX + halfW + Math.round(halfW / 2) - 8;
    const tempVisualH = textVisualHeight(fonts.displayLarge, temp) || 40;
    const tempY =
      Math.round(heroCenterY - tempVisualH / 2) - glyphTopOffset(fonts.displayLarge, temp);
    const forecast = fc.length > 0 ? fc : [null, null, null];
    const forecastRecords = forecast.slice(0, 3).map((item) => (isRecord(item) ? item : {}));
    const [heroIcon, ...forecastIcons] = await Promise.all([
      loadWeatherIconMask(normalizeWeatherCode(data.code), 'large'),
      ...forecastRecords.map((record) =>
        loadWeatherIconMask(normalizeWeatherCode(record.code), 'tiny')
      ),
    ]);

    this.drawWeatherIcon(c, heroIcon, iconCx, iconCy);
    const tempWidth = textWidth(fonts.displayLarge, temp);
    const tempX = Math.round(tempCenterX - tempWidth / 2);
    this.drawText(c, fonts.displayLarge, temp, tempX, tempY, {
      maxWidth: 92,
      ellipsis: true,
    });
    this.drawText(c, fonts.sans16, '°', tempX + Math.min(92, tempWidth + 4), tempY + 18, {
      maxWidth: 20,
    });
    const metrics = [
      feelsLike && feelsLike !== '--' ? `体感 ${feelsLike}°` : '体感 --',
      humidity === '--' ? '湿度 --' : `湿度 ${humidity}%`,
      wind,
    ];
    const metricX = 274;
    const metricGap = 30;
    const metricBlockH = fonts.sans16.lineHeight + metricGap * (metrics.length - 1);
    const metricY = Math.round(heroCenterY - metricBlockH / 2);
    metrics.forEach((line, index) => {
      this.drawText(c, fonts.sans16, line, metricX, metricY + index * metricGap, {
        maxWidth: CONTENT_RIGHT - metricX,
        ellipsis: true,
      });
    });

    this.drawRule(c, CONTENT_LEFT, forecastTop, CONTENT_WIDTH, 'dashed');
    const colW = Math.floor(CONTENT_WIDTH / 3);
    for (let index = 0; index < forecastRecords.length; index++) {
      const record = forecastRecords[index]!;
      const x = CONTENT_LEFT + index * colW;
      if (index > 0) this.drawVRule(c, x, forecastTop + 10, 110, 'dashed');
      const label = pickText(record.label, ['今日', '明日', '后天'][index] ?? '');
      const text = pickText(record.text, forecastTextFromVal(record.val));
      const min = pickText(record.tempMin, '');
      const max = pickText(record.tempMax, '');
      const range = formatTemperatureRange(min, max) || forecastRangeFromVal(record.val);
      const center = Math.round(x + colW / 2);
      this.drawText(c, fonts.sans16, label, center, forecastTop + 14, {
        align: 'center',
        maxWidth: colW - 12,
        ellipsis: true,
      });
      this.drawWeatherIcon(c, forecastIcons[index] ?? null, center, forecastTop + 55);
      this.drawText(c, fonts.metric12, range || '--', center, forecastTop + 84, {
        align: 'center',
        maxWidth: colW - 12,
        ellipsis: true,
      });
      this.drawText(c, fonts.sans16, text || '--', center, forecastTop + 108, {
        align: 'center',
        maxWidth: colW - 12,
        ellipsis: true,
      });
    }
  }

  private renderHistoryToday(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const data = ctx.data ?? {};
    const items = readHistoryItems(data);
    const source = items.length > 0 ? items : [{ year: null, text: FALLBACK_TEXT }];
    const rows = source.slice(0, 5);
    const timelineX = 58;
    const textX = timelineX + 18;
    const rowStep = rows.length >= 5 ? 49 : rows.length === 4 ? 58 : rows.length === 3 ? 70 : 82;
    const firstCenterY = CONTENT_SAFE_TOP + 36;
    const dotSize = 7;
    const dotRadius = Math.floor(dotSize / 2);
    const timelinePad = 18;
    const timelineTop = firstCenterY - timelinePad;
    const timelineBottom = firstCenterY + rowStep * (rows.length - 1) + timelinePad;
    c.drawVLine(timelineX, timelineTop, timelineBottom - timelineTop + 1, PIXEL_BLACK);

    for (const [index, item] of rows.entries()) {
      const centerY = firstCenterY + index * rowStep;
      const textY = centerY - Math.round((fonts.sans16.lineHeight * 2 + 2) / 2);
      if (item.year) {
        this.drawText(
          c,
          fonts.sans16,
          item.year,
          timelineX - 12,
          centerY - Math.round(fonts.sans16.lineHeight / 2),
          {
            align: 'right',
            maxWidth: 42,
            ellipsis: true,
          }
        );
      }
      c.fillRect(timelineX - dotRadius, centerY - dotRadius, dotSize, dotSize, PIXEL_BLACK);
      this.drawText(c, fonts.sans16, item.text, textX, textY, {
        maxWidth: CONTENT_RIGHT - textX,
        maxLines: 2,
        ellipsis: true,
        lineGap: 2,
      });
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

    if (metrics.length === 0) {
      const centerY = Math.round((CONTENT_SAFE_TOP + CONTENT_SAFE_BOTTOM) / 2);
      const lineGap = 12;
      const totalH = fonts.sans16.lineHeight + lineGap + fonts.metric12.lineHeight;
      const top = Math.round(centerY - totalH / 2);
      this.drawText(c, fonts.sans16, '等待数据推送', FRAME_WIDTH / 2, top, {
        align: 'center',
        maxWidth: CONTENT_WIDTH,
      });
      this.drawText(
        c,
        fonts.metric12,
        'POST /api/v1/contents/:id/data',
        FRAME_WIDTH / 2,
        top + 28,
        {
          align: 'center',
          maxWidth: CONTENT_WIDTH,
        }
      );
      return;
    }

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

  private renderHotList(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
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
      this.drawText(c, fonts.sans16, '暂无榜单数据', FRAME_WIDTH / 2, 136, {
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
      this.drawTextInBox(
        c,
        fonts.metric12,
        String(rank).padStart(2, '0'),
        rankX,
        rankY,
        rankBoxW,
        rankBoxH,
        topRank ? PIXEL_WHITE : PIXEL_BLACK
      );
      this.drawTextCenteredY(c, fonts.sans16, title, titleX, rowCenterY, {
        maxWidth: titleW,
        ellipsis: true,
      });

      if (index < items.length - 1)
        this.drawRule(c, CONTENT_LEFT, y + rowH - 1, CONTENT_WIDTH, 'dashed');
    });
  }

  private renderFontTest(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const fontId = readFontId(ctx.config.font_id);
    const entry = getDeviceFontEntry(fontId);
    const sampleFont = fonts.catalog[entry.id] ?? fonts.sans16;
    const invert = ctx.config.invert === true;
    const specimenKind =
      entry.kind === 'latin' && sampleFont.lineHeight >= 28 ? 'display' : entry.kind;
    const specimen = fontSpecimen(specimenKind, entry.id);
    const sampleForMissing =
      specimenKind === 'icon'
        ? ICON_FONT_TEST_SAMPLE
        : specimenKind === 'display'
          ? '23:59 86% +12 -04 OK RUN'
          : [specimen.hero, ...specimen.body, ...specimen.metrics, ...specimen.glyphs].join(' ');
    const missing = missingGlyphs(sampleFont, sampleForMissing);

    if (invert) {
      c.fillRect(0, STATUS_BAR_H, FRAME_WIDTH, FRAME_HEIGHT - STATUS_BAR_H, PIXEL_BLACK);
    }
    const fg = invert ? PIXEL_WHITE : PIXEL_BLACK;

    if (specimenKind === 'icon') this.renderFontIconSpecimen(c, sampleFont, fg);
    else if (specimenKind === 'display') {
      this.renderFontDisplaySpecimen(c, sampleFont, entry, specimen, fg, missing.length);
    } else {
      this.renderFontReadingSpecimen(c, sampleFont, entry, specimen, fg, missing.length);
    }
  }

  private renderFontReadingSpecimen(
    c: BitmapCanvas,
    sampleFont: BitmapFont,
    entry: DeviceFontCatalogEntry,
    specimen: FontSpecimen,
    fg: number,
    missingCount: number
  ): void {
    const x = CONTENT_LEFT;
    const maxWidth = CONTENT_WIDTH;
    const bottom = FRAME_HEIGHT - 8;
    const lineGap = fontTestLineGap(sampleFont);
    let y = STATUS_BAR_H + 9;

    y += this.drawText(c, sampleFont, entry.label, x, y, {
      maxWidth,
      ellipsis: true,
      color: fg,
    });
    y += Math.max(4, Math.floor(lineGap / 2));

    y += this.drawText(
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
    this.drawRuleColor(c, x, y, maxWidth, 'dashed', fg);
    y += lineGap + 2;

    for (const line of fontReadingLines(entry, specimen, sampleFont, missingCount)) {
      if (y + sampleFont.lineHeight > bottom) break;
      const used = this.drawText(c, sampleFont, line, x, y, {
        maxWidth,
        maxLines: sampleFont.lineHeight <= 12 ? 2 : 1,
        ellipsis: true,
        lineGap: 1,
        color: fg,
      });
      y += used + lineGap;
    }
  }

  private renderFontDisplaySpecimen(
    c: BitmapCanvas,
    sampleFont: BitmapFont,
    entry: DeviceFontCatalogEntry,
    specimen: FontSpecimen,
    fg: number,
    missingCount: number
  ): void {
    const huge = sampleFont.lineHeight >= 56;
    if (huge) {
      const lines = [
        specimen.hero,
        '86%',
        missingCount > 0 ? `missing ${missingCount}` : '+12 -04',
      ];
      const ySlots = [36, 128, 220];
      lines.forEach((text, index) => {
        this.drawText(c, sampleFont, text, 200, ySlots[index]!, {
          align: 'center',
          maxWidth: CONTENT_WIDTH,
          ellipsis: true,
          color: fg,
        });
      });
      return;
    }

    this.drawText(c, sampleFont, specimen.hero, 200, 34, {
      align: 'center',
      maxWidth: CONTENT_WIDTH,
      ellipsis: true,
      color: fg,
    });
    this.drawRuleColor(c, 72, 92, 256, 'dashed', fg);

    const values = ['86%', '+12', '-04'];
    const colW = Math.floor(CONTENT_WIDTH / values.length);
    values.forEach((value, index) => {
      const centerX = CONTENT_LEFT + index * colW + Math.floor(colW / 2);
      this.drawText(c, sampleFont, value, centerX, 112, {
        align: 'center',
        maxWidth: colW - 10,
        ellipsis: true,
        color: fg,
      });
    });

    this.drawRuleColor(c, 72, 176, 256, 'dashed', fg);
    this.drawText(c, sampleFont, specimen.glyphs[0] ?? 'OK RUN', 200, 190, {
      align: 'center',
      maxWidth: CONTENT_WIDTH,
      ellipsis: true,
      color: fg,
    });

    const footer = missingCount > 0 ? `${entry.label} missing ${missingCount}` : entry.label;
    this.drawText(c, sampleFont, footer, 200, 246, {
      align: 'center',
      maxWidth: CONTENT_WIDTH,
      ellipsis: true,
      color: fg,
    });
  }

  private renderFontIconSpecimen(c: BitmapCanvas, sampleFont: BitmapFont, fg: number): void {
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
      this.drawText(c, sampleFont, icon, x + Math.floor(cellW / 2), y, {
        align: 'center',
        maxWidth: cellW,
        color: fg,
      });
    });

    if (!large) {
      this.drawRuleColor(c, CONTENT_LEFT, 244, CONTENT_WIDTH, 'dashed', fg);
      this.drawText(c, sampleFont, '\uf240 \uf1eb \uf028 \uf071 \uf0f3 \uf011 \uf013', 200, 256, {
        align: 'center',
        maxWidth: CONTENT_WIDTH,
        ellipsis: true,
        color: fg,
      });
    }
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
    const boxH = 22;
    const textY = y + Math.round((boxH - fonts.sans16.lineHeight) / 2);
    c.strokeRect(x, y, boxW, boxH, PIXEL_BLACK);
    this.drawText(c, fonts.sans16, label, x + Math.floor(boxW / 2), textY, {
      align: 'center',
      maxWidth: boxW - 4,
    });
    this.drawText(c, fonts.sans16, value, x + boxW + 12, textY, {
      maxWidth: w - boxW - 12,
      ellipsis: true,
    });
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

  private drawWeatherIcon(c: BitmapCanvas, mask: BitmapMask | null, cx: number, cy: number): void {
    if (mask) c.drawMask(mask, Math.round(cx - mask.width / 2), Math.round(cy - mask.height / 2));
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
    const fallback = this.fallbackForFont(font);
    const lines = wrapText(
      font,
      fallback,
      text,
      opts.maxWidth ?? FRAME_WIDTH,
      opts.maxLines ?? 1,
      opts.ellipsis ?? false
    );
    let cursorY = y;
    for (const line of lines) {
      const width = textWidthFallback(font, fallback, line);
      const drawX =
        opts.align === 'center'
          ? Math.round(x - width / 2)
          : opts.align === 'right'
            ? x - width
            : x;
      drawTextLine(c, font, fallback, line, drawX, cursorY, opts.color ?? PIXEL_BLACK);
      cursorY += font.lineHeight + lineGap;
    }
    return lines.length * font.lineHeight + Math.max(0, lines.length - 1) * lineGap;
  }

  private drawTextInBox(
    c: BitmapCanvas,
    font: BitmapFont,
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
    color: number
  ): void {
    const fallback = this.fallbackForFont(font);
    const line = filterDrawable(font, fallback, text.trim());
    if (!line) return;
    const bounds = textPixelBounds(font, fallback, line);
    if (!bounds) return;
    const drawX = Math.round(x + (w - (bounds.right - bounds.left)) / 2 - bounds.left);
    const drawY = Math.round(y + (h - (bounds.bottom - bounds.top)) / 2 - bounds.top);
    drawTextLine(c, font, fallback, line, drawX, drawY, color);
  }

  private drawTextCenteredY(
    c: BitmapCanvas,
    font: BitmapFont,
    text: string,
    x: number,
    centerY: number,
    opts: Omit<TextOptions, 'maxLines' | 'lineGap'> = {}
  ): void {
    const fallback = this.fallbackForFont(font);
    const lines = wrapText(
      font,
      fallback,
      text,
      opts.maxWidth ?? FRAME_WIDTH,
      1,
      opts.ellipsis ?? false
    );
    const line = lines[0];
    if (!line) return;
    const bounds = textPixelBounds(font, fallback, line);
    if (!bounds) return;
    const width = textWidthFallback(font, fallback, line);
    const drawX =
      opts.align === 'center' ? Math.round(x - width / 2) : opts.align === 'right' ? x - width : x;
    const drawY = Math.round(centerY - (bounds.bottom - bounds.top) / 2 - bounds.top);
    drawTextLine(c, font, fallback, line, drawX, drawY, opts.color ?? PIXEL_BLACK);
  }

  private fallbackForFont(font: BitmapFont): BitmapFont | undefined {
    const fonts = this.fonts;
    if (!fonts) return undefined;
    // 只对 16px sans 提供 16px unifont fallback；小字号字体若缺字直接跳过，
    // 避免行高错位。fusion_pixel_10/12 本身就是 full cmap，缺字概率极低。
    return font === fonts.sans16 ? fonts.fallback16 : undefined;
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

function readHistoryItems(data: Record<string, unknown>): Array<{ year: string; text: string }> {
  // Render accepts only the current history_today contract; invalid data renders as fallback.
  const parsed = parseHistoryTodayData(data);
  if (!parsed) return [];
  return parsed.items.map((item) => ({ year: item.year, text: item.display }));
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

function fontSpecimen(kind: string, fontId: FontTestFontIdT): FontSpecimen {
  if (kind === 'cjk') {
    const compact = fontId === 'ark_pixel_16';
    return {
      hero: compact ? '中文 0123456789 ABC abc' : '墨水屏字体测试 中文点阵 0123456789',
      body: compact
        ? ['中文 ABC abc 123', '23:59 100% OK', 'A0 iIl1 O0 8B']
        : ['今日天气 多云 23°C  风力 2 级', '简繁中文 标点，。！？', 'ABC abc 0123456789 +12.8%'],
      metrics: ['0123456789 23:59'],
      glyphs: ['一二三 口日目 黑墨屏'],
    };
  }

  if (kind === 'display') {
    return {
      hero: '23:59',
      body: ['86%', '+12.8', '-04'],
      metrics: ['86% +12 -04'],
      glyphs: ['OK RUN'],
    };
  }

  return {
    hero: 'Slate UI 0123456789 ABC abc',
    body: ['The quick brown fox jumps.', 'A0 O0 I1 l1 []{} <> /\\', '23:59 100% +12.8 -04'],
    metrics: ['0123456789 23:59'],
    glyphs: ['A0 O0 I1 l1 mwMW'],
  };
}

function fontTestLineGap(font: BitmapFont): number {
  if (font.lineHeight <= 8) return 5;
  if (font.lineHeight <= 12) return 6;
  if (font.lineHeight <= 16) return 8;
  if (font.lineHeight <= 24) return 10;
  return 12;
}

function fontReadingLines(
  entry: DeviceFontCatalogEntry,
  specimen: FontSpecimen,
  font: BitmapFont,
  missingCount: number
): string[] {
  const footer = missingCount > 0 ? [`missing ${missingCount}`] : [];
  if (entry.kind === 'cjk') {
    if (entry.id === 'ark_pixel_16') {
      return [
        specimen.hero,
        ...specimen.body,
        ...specimen.metrics,
        ...specimen.glyphs,
        'ABCDEF abcdef 0123456789',
        'A0 O0 I1 l1 []{}<>',
        ...footer,
      ];
    }
    return [
      specimen.hero,
      '中文测试 墨水屏 点阵字体',
      '今天多云 23°C 风力 2级',
      '黑白像素 横竖撇捺 点线面',
      '简繁中文 标点，。！？；：',
      '一二三四五六七八九十 口日目田回',
      '0123456789 23:59 100% +12.8',
      'ABC abc A0 O0 I1 l1 []{}<>',
      ...footer,
    ];
  }

  const dense = font.lineHeight <= 12;
  return [
    specimen.hero,
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'abcdefghijklmnopqrstuvwxyz',
    '0123456789 23:59 100% +12.8 -04',
    'A0 O0 I1 l1 mwMW []{} <> /\\',
    dense ? 'The quick brown fox jumps over the lazy dog.' : 'The quick brown fox jumps.',
    'Slate UI e-paper bitmap font',
    '!@#$%^&*()_+-=;:,.?',
    ...(dense
      ? [
          '0123456789 ABCDEF abcdef',
          'render align width baseline',
          'pixel density row spacing test',
          'left center right edge sample',
        ]
      : []),
    ...footer,
  ];
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
  const m = text.match(/(-?\d+)°?[~～-](-?\d+)°?$/);
  return m ? formatTemperatureRange(m[1], m[2]) : '';
}

function formatTemperatureRange(min: string, max: string): string {
  const left = temperatureBound(min);
  const right = temperatureBound(max);
  if (left && right) return `${left}°~${right}°`;
  if (left) return `${left}°`;
  if (right) return `${right}°`;
  return '';
}

function temperatureBound(value: string): string | null {
  const text = value.trim().replace(/°+$/, '');
  return text && text !== '--' ? text : null;
}

function monthFromMonthDay(value: unknown, fallback: Date, timeZone: string): string {
  const text = pickText(value, formatDatePart(fallback, 'monthDay', timeZone));
  return String(Number(text.split(/[/-]/)[0] ?? 1));
}

function dayFromMonthDay(value: unknown, fallback: Date, timeZone: string): string {
  const text = pickText(value, formatDatePart(fallback, 'monthDay', timeZone));
  return String(Number(text.split(/[/-]/)[1] ?? text));
}

function wrapText(
  font: BitmapFont,
  fallback: BitmapFont | undefined,
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
    if (textWidthFallback(font, fallback, next) > maxWidth && cur.length > 0) {
      lines.push(cur);
      cur = ch;
      if (lines.length >= maxLines) break;
    } else {
      cur = next;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const clipped = lines.slice(0, maxLines).map((line) => filterDrawable(font, fallback, line));
  if (
    ellipsis &&
    clipped.length === maxLines &&
    textWidthFallback(font, fallback, clipped[clipped.length - 1] ?? '') > maxWidth
  ) {
    clipped[clipped.length - 1] = ellipsize(font, fallback, clipped[clipped.length - 1]!, maxWidth);
  } else if (ellipsis && source.length > clipped.join('').length && clipped.length > 0) {
    clipped[clipped.length - 1] = ellipsize(font, fallback, clipped[clipped.length - 1]!, maxWidth);
  }
  return clipped;
}

function filterDrawable(font: BitmapFont, fallback: BitmapFont | undefined, text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (hasGlyph(font, cp) || (fallback && hasGlyph(fallback, cp))) out += ch;
    else if (ch === ' ') out += ch;
  }
  return out;
}

function ellipsize(
  font: BitmapFont,
  fallback: BitmapFont | undefined,
  text: string,
  maxWidth: number
): string {
  const ell = hasGlyph(font, 0x2026) || (fallback && hasGlyph(fallback, 0x2026)) ? '…' : '.';
  let s = text;
  while (s.length > 0 && textWidthFallback(font, fallback, `${s}${ell}`) > maxWidth) {
    s = s.slice(0, -1);
  }
  return `${s}${ell}`;
}

function textWidthFallback(
  font: BitmapFont,
  fallback: BitmapFont | undefined,
  text: string
): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const glyph = font.glyphs.get(cp) ?? fallback?.glyphs.get(cp);
    if (glyph) w += Math.round(glyph.adv_w / 16);
  }
  return w;
}

function textVisualHeight(font: BitmapFont, text: string): number {
  const bounds = textVisualBounds(font, text);
  return bounds ? bounds.bottom - bounds.top : 0;
}

function glyphTopOffset(font: BitmapFont, text: string): number {
  return textVisualBounds(font, text)?.top ?? 0;
}

function textVisualBounds(font: BitmapFont, text: string): { top: number; bottom: number } | null {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const ch of text) {
    const glyph = font.glyphs.get(ch.codePointAt(0)!);
    if (!glyph) continue;
    const baselineY = font.lineHeight - font.baseLine;
    const glyphTop = baselineY - glyph.ofs_y - glyph.box_h;
    const glyphBottom = glyphTop + glyph.box_h;
    top = Math.min(top, glyphTop);
    bottom = Math.max(bottom, glyphBottom);
  }
  return Number.isFinite(top) && Number.isFinite(bottom) ? { top, bottom } : null;
}

function textPixelBounds(
  font: BitmapFont,
  fallback: BitmapFont | undefined,
  text: string
): { left: number; right: number; top: number; bottom: number } | null {
  let penX = 0;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const drawFont = hasGlyph(font, cp)
      ? font
      : fallback && hasGlyph(fallback, cp)
        ? fallback
        : null;
    if (!drawFont) continue;
    const glyph = drawFont.glyphs.get(cp)!;
    const baselineY = drawFont.lineHeight - drawFont.baseLine;
    const glyphLeft = penX + glyph.ofs_x;
    const glyphTop = baselineY - glyph.ofs_y - glyph.box_h;
    left = Math.min(left, glyphLeft);
    right = Math.max(right, glyphLeft + glyph.box_w);
    top = Math.min(top, glyphTop);
    bottom = Math.max(bottom, glyphTop + glyph.box_h);
    penX += Math.round(glyph.adv_w / 16);
  }
  return Number.isFinite(left) &&
    Number.isFinite(right) &&
    Number.isFinite(top) &&
    Number.isFinite(bottom)
    ? { left, right, top, bottom }
    : null;
}

function drawTextLine(
  c: BitmapCanvas,
  font: BitmapFont,
  fallback: BitmapFont | undefined,
  text: string,
  x: number,
  y: number,
  color: number
): number {
  let penX = x;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const drawFont = hasGlyph(font, cp)
      ? font
      : fallback && hasGlyph(fallback, cp)
        ? fallback
        : null;
    if (!drawFont) continue;
    const baselineY = y + drawFont.lineHeight - drawFont.baseLine;
    penX += c.drawGlyph(drawFont, cp, penX, baselineY, color);
  }
  return penX - x;
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

function monthCellSubtitle(dayData: unknown): string {
  if (!isRecord(dayData)) return '';
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
