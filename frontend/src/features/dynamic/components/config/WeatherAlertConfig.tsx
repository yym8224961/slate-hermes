import type { DynamicConfigT } from 'shared';
import { ProvinceSearch } from './ProvinceSearch';
import { DynamicRefreshSettings } from './RefreshSettings';
import type { DynamicConfigChange } from '@/features/dynamic/types';

export function WeatherAlertConfigPanel({
  config,
  onChange,
}: {
  config: Extract<DynamicConfigT, { type: 'weather_alert' }>;
  onChange: DynamicConfigChange;
}) {
  return (
    <div className="space-y-4">
      <ProvinceSearch
        value={config.province}
        onSelect={(province) => onChange({ ...config, province })}
      />
      <DynamicRefreshSettings config={config} onChange={onChange} />
    </div>
  );
}
