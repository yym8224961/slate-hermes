import { Injectable } from '@nestjs/common';
import { FontTestConfig, type FontTestConfigT } from 'shared';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';

export type FontTestProviderData = Record<string, never>;

@Injectable()
export class FontTestProvider implements DataProvider<FontTestConfigT, FontTestProviderData> {
  readonly type = 'font_test';

  validateConfig(raw: unknown): FontTestConfigT {
    return FontTestConfig.parse(raw);
  }

  fetchData(_config: FontTestConfigT, _ctx: DynamicContentFetchCtx): Promise<FontTestProviderData> {
    return Promise.resolve({});
  }
}
