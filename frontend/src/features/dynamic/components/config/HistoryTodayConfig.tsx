import { HistoryTodayConfig, type DynamicConfigT } from 'shared';
import { Select, SelectItem } from '@/components/ui/Select';
import type { DynamicConfigChange } from '@/features/dynamic/types';

type HistoryTodaySource = Extract<
  Extract<DynamicConfigT, { type: 'history_today' }>['source'],
  string
>;

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

function isHistoryTodaySource(value: string): value is HistoryTodaySource {
  return HistoryTodayConfig.shape.source.safeParse(value).success;
}
