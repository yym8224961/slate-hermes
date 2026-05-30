import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BITMAP_1BPP_FONT_DIR } from '../../../../infra/assets/asset-paths';
import { DEVICE_FONT_CATALOG } from './font-catalog';
import { loadBitmapFont, type BitmapFont } from './bitmap-font';

export interface FontSet {
  sans16: BitmapFont;
  sans12: BitmapFont;
  calendarSub10: BitmapFont;
  metric12: BitmapFont;
  fallback16: BitmapFont;
  displayLarge: BitmapFont;
  catalog: Partial<Record<string, BitmapFont>>;
}

@Injectable()
export class DynamicFrameFontService implements OnModuleInit {
  private fonts: FontSet | null = null;
  private fontsPromise: Promise<FontSet> | null = null;

  async onModuleInit(): Promise<void> {
    await this.getFonts();
  }

  async getFonts(): Promise<FontSet> {
    if (this.fonts) return this.fonts;
    this.fontsPromise ??= this.loadFonts().catch((err: unknown) => {
      this.fontsPromise = null;
      throw err;
    });
    return this.fontsPromise;
  }

  fallbackForFont(font: BitmapFont): BitmapFont | undefined {
    const fonts = this.fonts;
    if (!fonts) return undefined;
    // 只对 16px sans 提供 16px unifont fallback；小字号字体若缺字直接跳过，
    // 避免行高错位。fusion_pixel_10/12 本身就是 full cmap，缺字概率极低。
    return font === fonts.sans16 ? fonts.fallback16 : undefined;
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
