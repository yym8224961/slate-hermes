import {
  HOT_LIST_SOURCES_BY_NAME,
  CurrentHotListSourceId,
  hotListSourceDisplayLabel,
  type CurrentHotListSourceIdT,
  type DynamicConfigT,
} from 'shared';
import { Select, SelectItem } from '@/components/ui/Select';
import { DynamicRefreshSettings } from './RefreshSettings';
import type { DynamicConfigChange } from '@/features/dynamic/model/config-types';
import { createSafeParseGuard } from '@/lib/zod-utils';

const isCurrentHotListSource =
  createSafeParseGuard<CurrentHotListSourceIdT>(CurrentHotListSourceId);

export function HotListConfigPanel({
  config,
  onChange,
}: {
  config: Extract<DynamicConfigT, { type: 'hot_list' }>;
  onChange: DynamicConfigChange;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">频道</p>
        <Select
          value={config.source}
          onValueChange={(value) => {
            if (!isCurrentHotListSource(value)) return;
            onChange({ ...config, source: value });
          }}
        >
          {HOT_LIST_SOURCES_BY_NAME.map((source) => (
            <SelectItem key={source.id} value={source.id} hint={hotListKindLabel(source.kind)}>
              {hotListSourceDisplayLabel(source)}
            </SelectItem>
          ))}
        </Select>
      </div>
      <DynamicRefreshSettings config={config} onChange={onChange} />
    </div>
  );
}

function hotListKindLabel(kind: (typeof HOT_LIST_SOURCES_BY_NAME)[number]['kind']): string {
  switch (kind) {
    case 'general':
      return '综合';
    case 'news':
      return '新闻';
    case 'tech':
      return '科技';
    case 'community':
      return '社区';
    case 'commerce':
      return '消费';
  }
}
