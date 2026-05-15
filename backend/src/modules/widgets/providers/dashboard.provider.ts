import { Injectable } from '@nestjs/common';
import { DashboardConfig, type DashboardConfigT, type IngestPayloadT } from 'shared';
import type { DataProvider, WidgetFetchCtx } from '../widget-types';

/**
 * dashboard provider —— push-only。
 *
 * fetchData 永远不会主动发请求；scheduler 把 dashboard 排除在外。
 * dataOverride 来自 POST /contents/:contentId/data，已被 zod 校验为 IngestPayloadT。
 * lastData 是上一次 push 进来后落到 Content.dynamicData 的值（用于"没新数据时显示旧数据"）。
 */
@Injectable()
export class DashboardProvider implements DataProvider<DashboardConfigT, IngestPayloadT | null> {
  readonly type = 'dashboard';

  validateConfig(raw: unknown): DashboardConfigT {
    return DashboardConfig.parse(raw);
  }

  fetchData(_config: DashboardConfigT, ctx: WidgetFetchCtx): Promise<IngestPayloadT | null> {
    // override 来自当前 push 调用；lastData 来自之前的 push 落库；都没有 → null（首次未推数据）
    if (ctx.dataOverride !== undefined) {
      return Promise.resolve(ctx.dataOverride as IngestPayloadT);
    }
    return Promise.resolve((ctx.lastData as IngestPayloadT | undefined) ?? null);
  }
}
