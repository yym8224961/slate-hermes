import { HistoryTodayConfig, type DynamicConfigT } from 'shared';
import { Select, SelectItem } from '@/components/ui/Select';
import type { DynamicConfigChange } from '@/features/dynamic/model/config-types';
import { createSafeParseGuard } from '@/features/dynamic/lib/zod-utils';

type HistoryTodaySource = Extract<
  Extract<DynamicConfigT, { type: 'history_today' }>['source'],
  string
>;

const isHistoryTodaySource = createSafeParseGuard<HistoryTodaySource>(
  HistoryTodayConfig.shape.source
);

export function HistoryTodayConfigPanel({
  config,
  onChange,
}: {
  config: Extract<DynamicConfigT, { type: 'history_today' }>;
  onChange: DynamicConfigChange;
}) {
  return (
    <div>
      <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">数据源</p>
      <Select
        value={config.source}
        onValueChange={(value) => {
          if (!isHistoryTodaySource(value)) return;
          onChange({ ...config, source: value });
        }}
      >
        <SelectItem value="wikipedia" hint="默认">
          维基百科
        </SelectItem>
        <SelectItem value="baidu_baike" hint="百科">
          百度百科
        </SelectItem>
      </Select>
    </div>
  );
}
