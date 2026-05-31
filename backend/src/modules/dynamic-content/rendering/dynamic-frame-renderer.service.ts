import { Injectable } from '@nestjs/common';
import { FRAME_BYTES, FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import { BitmapCanvas, PIXEL_WHITE } from './bitmap-canvas';
import {
  renderDailyCalendarFrame,
  renderHistoryTodayFrame,
  renderMonthCalendarFrame,
} from './calendar-frame-renderer';
import { renderDashboardFrame } from './dashboard-frame-renderer';
import type { DynamicRenderContext } from './dynamic-render-context';
import { renderEarthquakeReportFrame } from './earthquake-frame-renderer';
import { FrameDrawKit } from './frame-draw-kit';
import { STATUS_BAR_H } from './frame-renderer-layout';
import { DynamicFrameFontService, type FontSet } from './fonts/dynamic-frame-font.service';
import { renderFontTestFrame } from './font-test-frame-renderer';
import { renderHotListFrame } from './hot-list-frame-renderer';
import { renderWeatherAlertFrame, renderWeatherFrame } from './weather-frame-renderer';

export type { DynamicRenderContext } from './dynamic-render-context';

@Injectable()
export class DynamicFrameRendererService {
  private readonly drawKit: FrameDrawKit;

  constructor(private readonly fontService: DynamicFrameFontService) {
    this.drawKit = new FrameDrawKit(fontService);
  }

  async render(ctx: DynamicRenderContext): Promise<Buffer> {
    const fonts = await this.fontService.getFonts();
    const c = new BitmapCanvas(FRAME_WIDTH, FRAME_HEIGHT);
    c.clear(PIXEL_WHITE);
    this.clearSystemStatusArea(c);

    switch (ctx.type) {
      case 'daily_calendar':
        renderDailyCalendarFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'month_calendar':
        renderMonthCalendarFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'weather':
        await renderWeatherFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'history_today':
        renderHistoryTodayFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'weather_alert':
        renderWeatherAlertFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'earthquake_report':
        renderEarthquakeReportFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'dashboard':
        renderDashboardFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'font_test':
        renderFontTestFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'hot_list':
        renderHotListFrame(c, fonts, ctx, this.drawKit);
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

  private clearSystemStatusArea(c: BitmapCanvas): void {
    c.fillRect(0, 0, FRAME_WIDTH, STATUS_BAR_H, PIXEL_WHITE);
  }

  private renderFallback(c: BitmapCanvas, fonts: FontSet, message: string): void {
    this.drawKit.drawText(c, fonts.sans16, message, 200, 140, {
      align: 'center',
      maxWidth: 320,
      maxLines: 2,
      ellipsis: true,
    });
  }
}
