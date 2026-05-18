import { Injectable } from '@nestjs/common';
import { DashboardConfig, type DashboardConfigT, type IngestPayloadT } from 'shared';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';

/**
 * dashboard provider —— push-only。
 *
 * fetchData 永远不会主动发请求；动态唤醒刷新时只复用上一份 push payload。
 * push payload 由 renderer 层直接写入 Content.dynamicData。
 * lastData 是上一次 push 进来后落到 Content.dynamicData 的值（用于"没新数据时显示旧数据"）。
 */
@Injectable()
export class DashboardProvider implements DataProvider<DashboardConfigT, IngestPayloadT | null> {
  readonly type = 'dashboard';

  validateConfig(raw: unknown): DashboardConfigT {
    return DashboardConfig.parse(raw);
  }

  fetchData(
    _config: DashboardConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<IngestPayloadT | null> {
    // lastData 来自之前的 push 落库；没有则返回 null（首次未推数据）
    return Promise.resolve((ctx.lastData as IngestPayloadT | undefined) ?? null);
  }
}
