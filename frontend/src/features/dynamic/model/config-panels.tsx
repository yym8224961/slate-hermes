import type { DynamicConfigT } from 'shared';
import { DashboardConfigPanel } from '@/features/dynamic/components/config/DashboardConfig';
import { FontTestConfigPanel } from '@/features/dynamic/components/config/FontTestConfig';
import { HistoryTodayConfigPanel } from '@/features/dynamic/components/config/HistoryTodayConfig';
import { HotListConfigPanel } from '@/features/dynamic/components/config/HotListConfig';
import { DynamicRefreshSettings } from '@/features/dynamic/components/config/RefreshSettings';
import { WeatherAlertConfigPanel } from '@/features/dynamic/components/config/WeatherAlertConfig';
import { WeatherConfigPanel } from '@/features/dynamic/components/config/WeatherConfig';
import type { DynamicConfigChange } from '@/features/dynamic/types';

export interface DynamicConfigPanelProps {
  config: DynamicConfigT;
  onChange: DynamicConfigChange;
  contentId?: string;
  dashboardData?: Record<string, unknown>;
  onDashboardDataChange?: (data: Record<string, unknown>) => void;
  dashboardDataLabel?: string;
}

export function DynamicConfigPanel({
  config,
  onChange,
  contentId,
  dashboardData,
  onDashboardDataChange,
  dashboardDataLabel,
}: DynamicConfigPanelProps) {
  switch (config.type) {
    case 'daily_calendar':
    case 'month_calendar':
      return null;
    case 'weather':
      return <WeatherConfigPanel config={config} onChange={onChange} />;
    case 'history_today':
      return <HistoryTodayConfigPanel config={config} onChange={onChange} />;
    case 'weather_alert':
      return <WeatherAlertConfigPanel config={config} onChange={onChange} />;
    case 'earthquake_report':
      return <DynamicRefreshSettings config={config} onChange={onChange} />;
    case 'dashboard':
      return (
        <DashboardConfigPanel
          config={config}
          onChange={onChange}
          contentId={contentId}
          dashboardData={dashboardData ?? {}}
          onDashboardDataChange={onDashboardDataChange}
          dataLabel={dashboardDataLabel}
        />
      );
    case 'font_test':
      return <FontTestConfigPanel config={config} onChange={onChange} />;
    case 'hot_list':
      return <HotListConfigPanel config={config} onChange={onChange} />;
  }
}
