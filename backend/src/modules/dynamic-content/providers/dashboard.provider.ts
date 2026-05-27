import { Injectable } from '@nestjs/common';
import { DashboardConfig, type DashboardConfigT } from 'shared';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';

/**
 * dashboard provider —— external data + template.
 *
 * fetchData 不主动请求外部系统。首次创建/预览使用 config.test_data；收到推送后
 * 复用上一份数据，设备刷新时只重新渲染。
 */
@Injectable()
export class DashboardProvider implements DataProvider<DashboardConfigT, Record<string, unknown> | null> {
  readonly type = 'dashboard';

  validateConfig(raw: unknown): DashboardConfigT {
    return DashboardConfig.parse(raw);
  }

  fetchData(
    config: DashboardConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<Record<string, unknown> | null> {
    return Promise.resolve((ctx.lastData as Record<string, unknown> | undefined) ?? config.test_data);
  }
}
