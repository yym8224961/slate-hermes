import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FRAME_BYTES,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  ICON_FONT_TEST_SAMPLE,
  type DashboardTemplateT,
} from 'shared';
import { BITMAP_1BPP_FONT_DIR } from '../../infra/assets/asset-paths';
import { traditionalFestivalShortName } from '../dynamic-content/traditional-festivals';
import { timezoneFromConfig } from '../dynamic-content/timezone';
import { BitmapCanvas, PIXEL_BLACK, PIXEL_WHITE, type BitmapMask } from './bitmap-canvas';
import {
  DEVICE_FONT_CATALOG,
  getDeviceFontEntry,
  type DeviceFontCatalogEntry,
} from './font-catalog';
import { loadBitmapFont, textWidth, type BitmapFont } from './bitmap-font';
import { loadWeatherIconMask } from './weather-icons';
import { readHistoryItems, monthCellSubtitle } from './calendar-render-utils';
import {
  blockRect,
  resolveDashboardRenderInput,
  resolvePercentage,
  resolveSeries,
  resolveTemplate,
} from './dashboard-template';
import { earthquakeFields } from './earthquake-render-utils';
import {
  dateParts,
  dayFromMonthDay,
  daysInMonth,
  formatShortTime,
  monthFromMonthDay,
  weekdayFor,
} from './frame-date-utils';
import {
  drawTextLine,
  ellipsize,
  filterDrawable,
  glyphTopOffset,
  textPixelBounds,
  textVisualHeight,
  textWidthFallback,
  wrapText,
} from './frame-text-layout';
import {
  getPath,
  isRecord,
  pad2,
  pickText,
  readAlign,
  readInt,
  readStringArray,
} from './frame-value-utils';
import {
  fontReadingLines,
  fontSpecimen,
  fontTestLineGap,
  fontTestSampleText,
  missingGlyphs,
  readFontId,
  type FontSpecimen,
} from './font-test-utils';
import {
  forecastRangeFromVal,
  forecastTextFromVal,
  formatTemperatureRange,
  normalizeWeatherCode,
  weatherAlertLine,
  weatherAlertSourceLabel,
  weatherAlertSummary,
} from './weather-render-utils';

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

const STATUS_BAR_H = 24;
const CONTENT_SAFE_TOP = STATUS_BAR_H;
const CONTENT_SAFE_BOTTOM = FRAME_HEIGHT;
const CONTENT_LEFT = 20;
const CONTENT_RIGHT = FRAME_WIDTH - 20;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const FALLBACK_TEXT = '暂无数据';
const HOT_LIST_RENDER_COUNT = 8;
const FONT_TEST_COMPACT_METRICS: Record<string, { lineHeight: number; baseLine: number }> = {
  fusion_pixel_10: { lineHeight: 10, baseLine: 2 },
  fusion_pixel_12: { lineHeight: 12, baseLine: 2 },
  ark_pixel_10: { lineHeight: 10, baseLine: 2 },
  ark_pixel_12: { lineHeight: 12, baseLine: 2 },
  ark_pixel_16: { lineHeight: 16, baseLine: 3 },
};

@Injectable()
export class DynamicFrameRendererService implements OnModuleInit {
  private fonts: FontSet | null = null;
  private fontsPromise: Promise<FontSet> | null = null;

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
      case 'weather_alert':
        this.renderWeatherAlert(c, fonts, ctx);
        break;
      case 'earthquake_report':
        this.renderEarthquakeReport(c, fonts, ctx);
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
    this.fontsPromise ??= this.loadFonts().catch((err: unknown) => {
      this.fontsPromise = null;
      throw err;
    });
    return this.fontsPromise;
  }

  private async loadFonts(): Promise<FontSet> {
    const fusionPixel10 = await loadBitmapFont(resolveFontPath('fusion-pixel-10.json'));
    this.fonts = {
      sans16: await loadBitmapFont(resolveFontPath('source-han-sans-16-slim.json')),
      sans12: fusionPixel10,
      calendarSub10: fusionPixel10,
      metric12: await loadBitmapFont(resolveFontPath('spleen-6x12.json')),
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
    const tempFallback = this.fallbackForFont(fonts.displayLarge);
    const tempVisualH = textVisualHeight(fonts.displayLarge, temp, tempFallback) || 40;
    const tempY =
      Math.round(heroCenterY - tempVisualH / 2) -
      glyphTopOffset(fonts.displayLarge, temp, tempFallback);
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
    const visibleTemp = ellipsize(fonts.displayLarge, tempFallback, temp, 92);
    const visibleTempWidth = textWidthFallback(fonts.displayLarge, tempFallback, visibleTemp);
    this.drawText(c, fonts.sans16, '°', tempX + visibleTempWidth + 4, tempY + 18, {
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

  private renderWeatherAlert(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const data = ctx.data ?? {};
    const rawItems = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
    const items = rawItems.slice(0, 9);
    const tz = timezoneFromConfig(ctx.config);

    if (items.length === 0) {
      const province = pickText(data.province, '');
      const text = province ? `${weatherAlertSourceLabel(province)}暂无预警` : '暂无气象预警';
      this.drawText(c, fonts.sans16, text, FRAME_WIDTH / 2, 146, {
        align: 'center',
        maxWidth: CONTENT_WIDTH,
      });
      return;
    }

    const startY = STATUS_BAR_H + 7;
    const rowH = Math.min(30, Math.floor((FRAME_HEIGHT - startY - 4) / items.length));
    const badgeW = 34;
    const badgeH = 22;
    const titleX = CONTENT_LEFT + 44;
    const timeW = 44;
    const titleW = CONTENT_RIGHT - titleX - timeW - 10;
    items.forEach((item, index) => {
      const y = startY + index * rowH;
      const centerY = y + Math.floor(rowH / 2);
      const titleText = pickText(item.title, FALLBACK_TEXT);
      const timeText = formatShortTime(item.issuedAt, ctx.renderedAt, tz);
      const summary = weatherAlertSummary(titleText);
      this.drawBadge(
        c,
        fonts,
        summary.kindLabel || summary.levelShort,
        CONTENT_LEFT,
        Math.round(centerY - badgeH / 2),
        badgeW,
        badgeH,
        summary.level.filled
      );
      this.drawTextCenteredY(c, fonts.sans16, weatherAlertLine(summary), titleX, centerY, {
        maxWidth: titleW,
        ellipsis: true,
      });
      if (timeText) {
        this.drawTextCenteredY(c, fonts.metric12, timeText, CONTENT_RIGHT, centerY, {
          align: 'right',
          maxWidth: timeW,
          ellipsis: true,
        });
      }
      if (index < items.length - 1)
        this.drawRule(c, titleX, y + rowH - 1, CONTENT_RIGHT - titleX, 'dashed');
    });
  }

  private renderEarthquakeReport(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const data = ctx.data ?? {};
    const rawItems = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
    const items = rawItems.slice(0, 4);
    const tz = timezoneFromConfig(ctx.config);
    const updatedAt = formatShortTime(data.updatedAt, ctx.renderedAt, tz);

    if (items.length === 0) {
      if (updatedAt) {
        this.drawText(c, fonts.sans12, `更新 ${updatedAt}`, CONTENT_RIGHT, STATUS_BAR_H + 12, {
          align: 'right',
          maxWidth: 116,
          ellipsis: true,
        });
      }
      this.drawText(c, fonts.sans16, '暂无地震速报', FRAME_WIDTH / 2, 146, {
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
    this.drawText(c, fonts.sans12, '震级', CONTENT_LEFT + 8, heroY + 8, {
      maxWidth: magW - 16,
      ellipsis: true,
      color: PIXEL_WHITE,
    });
    this.drawMagnitudeValue(c, fonts, magText, CONTENT_LEFT + 4, heroY + 22, magW - 8, 58);
    this.drawText(
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
    const locationH = this.drawStrongText(c, fonts.sans16, location, heroTextX, heroY + 4, {
      maxWidth: heroTextW,
      maxLines: 2,
      ellipsis: true,
      lineGap: 2,
    });
    const fieldY = heroY + Math.max(34, locationH + 8);
    this.drawFieldPair(c, fonts, '时间', fields.time || '--', heroTextX, fieldY, heroTextW);
    this.drawFieldPair(c, fonts, '深度', fields.depth, heroTextX, fieldY + 21, heroTextW);
    this.drawFieldPair(c, fonts, '坐标', fields.coords || '--', heroTextX, fieldY + 42, heroTextW);

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

      this.drawBadge(c, fonts, `M${magnitude}`, CONTENT_LEFT, y + 11, 52, 24, index === 0);
      this.drawText(c, fonts.sans16, location, CONTENT_LEFT + 66, titleY, {
        maxWidth: CONTENT_RIGHT - CONTENT_LEFT - 66,
        maxLines: 1,
        ellipsis: true,
      });
      if (fields.time) {
        this.drawText(c, fonts.metric12, fields.time, CONTENT_LEFT + 66, detailY, {
          maxWidth: 62,
          ellipsis: true,
        });
      }
      this.drawText(c, fonts.metric12, fields.depth, CONTENT_LEFT + 138, detailY, {
        maxWidth: CONTENT_RIGHT - CONTENT_LEFT - 138,
        ellipsis: true,
      });
      if (index < rest.length - 1)
        this.drawRule(
          c,
          CONTENT_LEFT + 66,
          y + rowH - 1,
          CONTENT_RIGHT - CONTENT_LEFT - 66,
          'dashed'
        );
    });
  }

  private renderDashboard(c: BitmapCanvas, fonts: FontSet, ctx: DynamicRenderContext): void {
    const resolved = resolveDashboardRenderInput(ctx);
    if (!resolved) {
      const centerY = Math.round((CONTENT_SAFE_TOP + CONTENT_SAFE_BOTTOM) / 2);
      this.drawText(c, fonts.sans16, '等待外部数据', FRAME_WIDTH / 2, centerY - 20, {
        align: 'center',
        maxWidth: CONTENT_WIDTH,
      });
      this.drawText(
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

    this.renderDashboardTemplate(c, fonts, resolved.template, resolved.data);
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

  private renderDashboardTemplate(
    c: BitmapCanvas,
    fonts: FontSet,
    template: DashboardTemplateT,
    dataRoot: Record<string, unknown>
  ): void {
    for (const rawBlock of template.blocks) {
      const type = rawBlock.type;
      if (type === 'text') {
        const rect = blockRect(rawBlock);
        if (!rect) continue;
        const font = rawBlock.font_size === 12 ? fonts.sans12 : fonts.sans16;
        const color = rawBlock.color === 'white' ? PIXEL_WHITE : PIXEL_BLACK;
        const align = readAlign(rawBlock.align);
        const text = resolveTemplate(pickText(rawBlock.value, ''), dataRoot);
        const anchorX =
          align === 'center'
            ? rect.x + Math.round(rect.w / 2)
            : align === 'right'
              ? rect.x + rect.w
              : rect.x;
        const textOptions = {
          align,
          maxWidth: rect.w,
          maxLines: readInt(rawBlock.max_lines, 1, 1, 4),
          ellipsis: true,
          color,
        };
        this.drawText(c, font, text, anchorX, rect.y, textOptions);
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
      } else if (type === 'progress') {
        const rect = blockRect(rawBlock);
        if (!rect) continue;
        this.drawProgressBlock(
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
          rawBlock.bar_height
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

  private drawFieldPair(
    c: BitmapCanvas,
    fonts: FontSet,
    label: string,
    value: string,
    x: number,
    y: number,
    w: number
  ): void {
    const labelW = 38;
    this.drawText(c, fonts.sans16, label, x, y, {
      maxWidth: labelW,
      ellipsis: true,
    });
    this.drawText(c, fonts.sans16, value, x + labelW + 8, y, {
      maxWidth: w - labelW - 8,
      ellipsis: true,
    });
  }

  private drawBadge(
    c: BitmapCanvas,
    fonts: FontSet,
    label: string,
    x: number,
    y: number,
    w: number,
    h: number,
    filled: boolean
  ): void {
    if (filled) c.fillRect(x, y, w, h, PIXEL_BLACK);
    else c.strokeRect(x, y, w, h, PIXEL_BLACK);
    const font =
      textWidth(fonts.sans16, label) <= w - 4
        ? fonts.sans16
        : textWidth(fonts.sans12, label) <= w - 4
          ? fonts.sans12
          : fonts.metric12;
    this.drawTextInBox(c, font, label, x, y, w, h, filled ? PIXEL_WHITE : PIXEL_BLACK);
  }

  private drawStrongText(
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
      drawTextLine(c, font, fallback, line, drawX + 1, cursorY, opts.color ?? PIXEL_BLACK);
      cursorY += font.lineHeight + lineGap;
    }
    return lines.length * font.lineHeight + Math.max(0, lines.length - 1) * lineGap;
  }

  private drawMagnitudeValue(
    c: BitmapCanvas,
    fonts: FontSet,
    value: string,
    x: number,
    y: number,
    w: number,
    h: number
  ): void {
    const compact = value.match(/^(\d+)\.(\d)$/);
    if (compact) {
      const digitW = 42;
      const centerX = x + Math.round(w / 2);
      this.drawTextInBox(
        c,
        fonts.displayLarge,
        compact[1]!,
        centerX - digitW - 7,
        y,
        digitW,
        h,
        PIXEL_WHITE
      );
      this.drawTextInBox(
        c,
        fonts.displayLarge,
        compact[2]!,
        centerX + 7,
        y,
        digitW,
        h,
        PIXEL_WHITE
      );
      c.fillRect(centerX - 3, y + h - 20, 7, 7, PIXEL_WHITE);
      return;
    }

    const font = textWidth(fonts.displayLarge, value) <= w - 4 ? fonts.displayLarge : fonts.sans16;
    this.drawTextInBox(c, font, value, x, y, w, h, PIXEL_WHITE);
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
    this.drawText(c, fonts.sans16, value, x + 7, y + 27, { maxWidth: w - 14, ellipsis: true });
    if (series.length >= 2 && h >= 54) {
      this.drawSparkline(c, x + 7, y + h - 18, w - 14, 10, series);
    }
  }

  private drawProgressBlock(
    c: BitmapCanvas,
    fonts: FontSet,
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    valueText: string,
    percentage: number,
    labelFontSize = 12,
    valueFontSize = 12,
    barHeight = 9
  ): void {
    const labelFont = labelFontSize === 16 ? fonts.sans16 : fonts.sans12;
    const valueFont = valueFontSize === 16 ? fonts.sans16 : fonts.sans12;
    const labelTextW = textWidthFallback(labelFont, this.fallbackForFont(labelFont), label);
    const valueTextW = valueText
      ? textWidthFallback(valueFont, this.fallbackForFont(valueFont), valueText)
      : 0;
    const labelW = Math.min(Math.max(labelTextW + 8, 58), Math.round(w * 0.36));
    const barX = x + labelW;
    const valueW = valueText ? Math.min(Math.max(valueTextW + 4, 34), 78) : 0;
    const barW = Math.max(12, w - labelW - valueW - 10);
    const barH = Math.max(4, Math.min(barHeight, h - 4));
    const centerY = y + Math.round(h / 2);
    const barY = centerY - Math.floor(barH / 2);
    this.drawTextCenteredY(c, labelFont, label, x, centerY, {
      maxWidth: labelW - 6,
      ellipsis: true,
    });
    c.strokeRect(barX, barY, barW, barH, PIXEL_BLACK);
    const fillW = Math.max(0, Math.min(barW - 2, Math.round(((barW - 2) * percentage) / 100)));
    if (fillW > 0) c.fillRect(barX + 1, barY + 1, fillW, barH - 2, PIXEL_BLACK);
    if (valueText) {
      this.drawTextCenteredY(c, valueFont, valueText, x + w, centerY, {
        align: 'right',
        maxWidth: valueW,
        ellipsis: true,
      });
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
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
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
  const path = resolve(BITMAP_1BPP_FONT_DIR, file);
  if (!existsSync(path)) throw new Error(`device font not found: ${path}`);
  return path;
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

function compactFontTestFont(font: BitmapFont, entry: DeviceFontCatalogEntry): BitmapFont {
  const metrics = FONT_TEST_COMPACT_METRICS[entry.id];
  if (!metrics) return font;
  return {
    ...font,
    lineHeight: metrics.lineHeight,
    baseLine: metrics.baseLine,
  };
}
