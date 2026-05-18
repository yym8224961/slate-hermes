import { Injectable } from '@nestjs/common';
import { FontTestConfig, type FontTestConfigT } from 'shared';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';
import { getDeviceFontEntry } from '../../frame-renderer/font-catalog';

export interface FontTestProviderData {
  fontLabel: string;
  fontId: string;
  sizePx: number;
  note: string;
  sampleText: string;
  digits: string;
  latin: string;
  cjk: string;
}

@Injectable()
export class FontTestProvider implements DataProvider<FontTestConfigT, FontTestProviderData> {
  readonly type = 'font_test';

  validateConfig(raw: unknown): FontTestConfigT {
    return FontTestConfig.parse(normalizeRemovedFont(raw));
  }

  fetchData(config: FontTestConfigT, _ctx: DynamicContentFetchCtx): Promise<FontTestProviderData> {
    const font = getDeviceFontEntry(config.font_id);
    return Promise.resolve({
      fontLabel: font.label,
      fontId: font.id,
      sizePx: font.sizePx,
      note: font.note,
      sampleText: config.sample_text,
      digits: '0123456789 100% -- 23:59',
      latin: 'ABCDEF abcdef Slate UI',
      cjk: '中文测试 墨水屏 点阵 字体',
    });
  }
}

function normalizeRemovedFont(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const config = raw as Record<string, unknown>;
  if (
    config.font_id !== 'wqy_bitmap_song_12' &&
    config.font_id !== 'wqy_bitmap_song_16' &&
    config.font_id !== 'dotted_songti_12'
  ) {
    return raw;
  }
  return {
    ...config,
    font_id: 'fusion_pixel_12',
  };
}
