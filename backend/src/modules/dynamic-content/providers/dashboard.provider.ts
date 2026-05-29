import { Injectable } from '@nestjs/common';
import { DashboardConfig, DashboardDataPayload, type DashboardConfigT } from 'shared';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';

/**
 * dashboard provider —— external data + template.
 *
 * fetchData 不主动请求外部系统，只复用 Content.dynamicData 中的当前 payload。
 * 新建时由 initial_data 初始化 dynamicData；后续由推送接口更新。
 */
@Injectable()
export class DashboardProvider implements DataProvider<
  DashboardConfigT,
  Record<string, unknown> | null
> {
  readonly type = 'dashboard';

  validateConfig(raw: unknown): DashboardConfigT {
    return DashboardConfig.parse(raw);
  }

  fetchData(
    _config: DashboardConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<Record<string, unknown> | null> {
    const parsed = DashboardDataPayload.safeParse(ctx.lastData);
    if (!parsed.success) {
      throw new Error('dashboard 数据为空，请先提供初始数据或推送数据');
    }
    return Promise.resolve(parsed.data);
  }
}
