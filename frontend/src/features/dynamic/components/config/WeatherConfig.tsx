import type { DynamicConfigT } from 'shared';
import { CitySearch } from './CitySearch';
import { DynamicRefreshSettings } from './RefreshSettings';
import type { DynamicConfigChange } from '@/features/dynamic/types';

export function WeatherConfigPanel({
  config,
  onChange,
}: {
  config: Extract<DynamicConfigT, { type: 'weather' }>;
  onChange: DynamicConfigChange;
}) {
  return (
    <div className="space-y-4">
      <CitySearch
        value={config.location_label}
        onSelect={({ locationId, label }) =>
          onChange({
            ...config,
            provider: 'qweather',
            location_id: locationId,
            location_label: label,
          })
        }
      />
      <DynamicRefreshSettings config={config} onChange={onChange} />
    </div>
  );
}
