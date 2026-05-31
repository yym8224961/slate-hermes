import { FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import { timezoneFromConfig } from '../timezone';
import { BitmapCanvas, type BitmapMask } from './bitmap-canvas';
import type { DynamicRenderContext } from './dynamic-render-context';
import { type FrameDrawKit } from './frame-draw-kit';
import {
  CONTENT_LEFT,
  CONTENT_RIGHT,
  CONTENT_SAFE_TOP,
  CONTENT_WIDTH,
  FALLBACK_TEXT,
  STATUS_BAR_H,
} from './frame-renderer-layout';
import { textWidth } from './fonts/bitmap-font';
import type { FontSet } from './fonts/dynamic-frame-font.service';
import { formatShortTime } from './helpers/frame-date-utils';
import { isRecord, pickText } from './helpers/frame-value-utils';
import { loadWeatherIconMask } from './helpers/weather-icons';
import {
  forecastRangeFromVal,
  forecastTextFromVal,
  formatTemperatureRange,
  normalizeWeatherCode,
  weatherAlertLine,
  weatherAlertSourceLabel,
  weatherAlertSummary,
} from './helpers/weather-render-utils';
import {
  ellipsize,
  glyphTopOffset,
  textVisualHeight,
  textWidthFallback,
} from './frame-text-layout';

export async function renderWeatherFrame(
  c: BitmapCanvas,
  fonts: FontSet,
  ctx: DynamicRenderContext,
  draw: FrameDrawKit
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
  const tempFallback = draw.fallbackForFont(fonts.displayLarge);
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

  drawWeatherIcon(c, heroIcon, iconCx, iconCy);
  const tempWidth = textWidth(fonts.displayLarge, temp);
  const tempX = Math.round(tempCenterX - tempWidth / 2);
  draw.drawText(c, fonts.displayLarge, temp, tempX, tempY, {
    maxWidth: 92,
    ellipsis: true,
  });
  const visibleTemp = ellipsize(fonts.displayLarge, tempFallback, temp, 92);
  const visibleTempWidth = textWidthFallback(fonts.displayLarge, tempFallback, visibleTemp);
  draw.drawText(c, fonts.sans16, '°', tempX + visibleTempWidth + 4, tempY + 18, {
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
    draw.drawText(c, fonts.sans16, line, metricX, metricY + index * metricGap, {
      maxWidth: CONTENT_RIGHT - metricX,
      ellipsis: true,
    });
  });

  draw.drawRule(c, CONTENT_LEFT, forecastTop, CONTENT_WIDTH, 'dashed');
  const colW = Math.floor(CONTENT_WIDTH / 3);
  for (let index = 0; index < forecastRecords.length; index++) {
    const record = forecastRecords[index]!;
    const x = CONTENT_LEFT + index * colW;
    if (index > 0) draw.drawVRule(c, x, forecastTop + 10, 110, 'dashed');
    const label = pickText(record.label, ['今日', '明日', '后天'][index] ?? '');
    const text = pickText(record.text, forecastTextFromVal(record.val));
    const min = pickText(record.tempMin, '');
    const max = pickText(record.tempMax, '');
    const range = formatTemperatureRange(min, max) || forecastRangeFromVal(record.val);
    const center = Math.round(x + colW / 2);
    draw.drawText(c, fonts.sans16, label, center, forecastTop + 14, {
      align: 'center',
      maxWidth: colW - 12,
      ellipsis: true,
    });
    drawWeatherIcon(c, forecastIcons[index] ?? null, center, forecastTop + 55);
    draw.drawText(c, fonts.metric12, range || '--', center, forecastTop + 84, {
      align: 'center',
      maxWidth: colW - 12,
      ellipsis: true,
    });
    draw.drawText(c, fonts.sans16, text || '--', center, forecastTop + 108, {
      align: 'center',
      maxWidth: colW - 12,
      ellipsis: true,
    });
  }
}

export function renderWeatherAlertFrame(
  c: BitmapCanvas,
  fonts: FontSet,
  ctx: DynamicRenderContext,
  draw: FrameDrawKit
): void {
  const data = ctx.data ?? {};
  const rawItems = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
  const items = rawItems.slice(0, 9);
  const tz = timezoneFromConfig(ctx.config);

  if (items.length === 0) {
    const province = pickText(data.province, '');
    const text = province ? `${weatherAlertSourceLabel(province)}暂无预警` : '暂无气象预警';
    draw.drawText(c, fonts.sans16, text, FRAME_WIDTH / 2, 146, {
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
    draw.drawBadge(
      c,
      fonts,
      summary.kindLabel || summary.levelShort,
      CONTENT_LEFT,
      Math.round(centerY - badgeH / 2),
      badgeW,
      badgeH,
      summary.level.filled
    );
    draw.drawTextCenteredY(c, fonts.sans16, weatherAlertLine(summary), titleX, centerY, {
      maxWidth: titleW,
      ellipsis: true,
    });
    if (timeText) {
      draw.drawTextCenteredY(c, fonts.metric12, timeText, CONTENT_RIGHT, centerY, {
        align: 'right',
        maxWidth: timeW,
        ellipsis: true,
      });
    }
    if (index < items.length - 1) {
      draw.drawRule(c, titleX, y + rowH - 1, CONTENT_RIGHT - titleX, 'dashed');
    }
  });
}

function drawWeatherIcon(c: BitmapCanvas, mask: BitmapMask | null, cx: number, cy: number): void {
  if (mask) c.drawMask(mask, Math.round(cx - mask.width / 2), Math.round(cy - mask.height / 2));
}
