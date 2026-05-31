import { FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import { traditionalFestivalShortName } from '../traditional-festivals';
import { daysInMonth, timezoneFromConfig } from '../timezone';
import { BitmapCanvas, PIXEL_BLACK, PIXEL_WHITE } from './bitmap-canvas';
import type { DynamicRenderContext } from './dynamic-render-context';
import { type FrameDrawKit } from './frame-draw-kit';
import {
  CONTENT_LEFT,
  CONTENT_RIGHT,
  CONTENT_SAFE_BOTTOM,
  CONTENT_SAFE_TOP,
  CONTENT_WIDTH,
  FALLBACK_TEXT,
} from './frame-renderer-layout';
import { textWidth } from './fonts/bitmap-font';
import type { FontSet } from './fonts/dynamic-frame-font.service';
import { readHistoryItems, monthCellSubtitle } from './helpers/calendar-render-utils';
import {
  dateParts,
  dayFromMonthDay,
  monthFromMonthDay,
  weekdayFor,
} from './helpers/frame-date-utils';
import { getPath, isRecord, pad2, pickText, readStringArray } from './helpers/frame-value-utils';

export function renderDailyCalendarFrame(
  c: BitmapCanvas,
  fonts: FontSet,
  ctx: DynamicRenderContext,
  draw: FrameDrawKit
): void {
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
    nextSolarTermDays === null ? '' : nextSolarTermDays === 0 ? '今天' : `${nextSolarTermDays}天后`;

  const ruleY = Math.round((CONTENT_SAFE_TOP + CONTENT_SAFE_BOTTOM) / 2);
  const upperTop = CONTENT_SAFE_TOP + 18;
  const upperBottom = ruleY - 16;
  const dateY = upperTop + Math.round((upperBottom - upperTop - fonts.displayLarge.lineHeight) / 2);
  const rightY =
    upperTop + Math.round((upperBottom - upperTop - (fonts.sans16.lineHeight * 3 + 14 * 2)) / 2);
  const dateX = 18;
  const rightX = 202;
  draw.drawText(c, fonts.displayLarge, monthDay, dateX, dateY, {
    maxWidth: 176,
    ellipsis: true,
  });
  draw.drawText(c, fonts.sans16, weekday || '今日', rightX, rightY, {
    maxWidth: CONTENT_RIGHT - rightX,
    ellipsis: true,
  });
  if (lunarDate) {
    draw.drawText(c, fonts.sans16, lunarDate, rightX, rightY + 30, {
      maxWidth: CONTENT_RIGHT - rightX,
      ellipsis: true,
    });
  }
  if (ganzhi) {
    draw.drawText(c, fonts.sans16, ganzhi, rightX, rightY + 60, {
      maxWidth: CONTENT_RIGHT - rightX,
      maxLines: 1,
      ellipsis: true,
    });
  }
  draw.drawRule(c, CONTENT_LEFT, ruleY, CONTENT_WIDTH, 'dashed');

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
  if (infoRow)
    drawInfoRow(c, fonts, infoRow[0], infoRow[1], CONTENT_LEFT, infoY, CONTENT_WIDTH, draw);
  if (yi) drawLabeledText(c, fonts, '宜', yi, CONTENT_LEFT, yiY, CONTENT_WIDTH, draw);
  if (ji) drawLabeledText(c, fonts, '忌', ji, CONTENT_LEFT, jiY, CONTENT_WIDTH, draw);
}

export function renderMonthCalendarFrame(
  c: BitmapCanvas,
  fonts: FontSet,
  ctx: DynamicRenderContext,
  draw: FrameDrawKit
): void {
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
    draw.drawText(c, fonts.sans16, label, cx, y0, {
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

    draw.drawText(c, fonts.sans16, String(day), x + Math.floor(colW / 2), y + 2, {
      align: 'center',
      maxWidth: colW - 4,
      color: isToday ? PIXEL_WHITE : PIXEL_BLACK,
    });

    const iso = `${parts.year}-${pad2(parts.month)}-${pad2(day)}`;
    const dayData = isRecord(days) ? days[iso] : null;
    const sub = monthCellSubtitle(dayData);
    if (sub) {
      draw.drawText(c, fonts.calendarSub10, sub, x + Math.floor(colW / 2), y + 15, {
        align: 'center',
        maxWidth: colW - 2,
        color: PIXEL_BLACK,
        ellipsis: true,
      });
    }
  }
}

export function renderHistoryTodayFrame(
  c: BitmapCanvas,
  fonts: FontSet,
  ctx: DynamicRenderContext,
  draw: FrameDrawKit
): void {
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
      draw.drawText(
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
    draw.drawText(c, fonts.sans16, item.text, textX, textY, {
      maxWidth: CONTENT_RIGHT - textX,
      maxLines: 2,
      ellipsis: true,
      lineGap: 2,
    });
  }
}

function drawLabeledText(
  c: BitmapCanvas,
  fonts: FontSet,
  label: string,
  value: string,
  x: number,
  y: number,
  w: number,
  draw: FrameDrawKit
): void {
  const boxW = 24;
  const boxH = 22;
  const textY = y + Math.round((boxH - fonts.sans16.lineHeight) / 2);
  c.strokeRect(x, y, boxW, boxH, PIXEL_BLACK);
  draw.drawText(c, fonts.sans16, label, x + Math.floor(boxW / 2), textY, {
    align: 'center',
    maxWidth: boxW - 4,
  });
  draw.drawText(c, fonts.sans16, value, x + boxW + 12, textY, {
    maxWidth: w - boxW - 12,
    ellipsis: true,
  });
}

function drawInfoRow(
  c: BitmapCanvas,
  fonts: FontSet,
  label: string,
  value: string,
  x: number,
  y: number,
  w: number,
  draw: FrameDrawKit
): void {
  const labelText = `${label}:`;
  const labelW = Math.min(94, Math.max(24, textWidth(fonts.sans16, labelText) + 4));
  draw.drawText(c, fonts.sans16, labelText, x, y + 1, {
    maxWidth: labelW,
  });
  draw.drawText(c, fonts.sans16, value, x + labelW + 8, y + 1, {
    maxWidth: w - labelW - 8,
    ellipsis: true,
  });
}
