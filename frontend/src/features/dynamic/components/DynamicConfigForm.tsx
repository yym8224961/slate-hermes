import type { DynamicConfigT } from 'shared';
import { WeatherConfigPanel } from './config/WeatherConfig';
import { WeatherAlertConfigPanel } from './config/WeatherAlertConfig';
import { HistoryTodayConfigPanel } from './config/HistoryTodayConfig';
import { HotListConfigPanel } from './config/HotListConfig';
import { DashboardConfigPanel } from './config/DashboardConfig';
import { FontTestConfigPanel } from './config/FontTestConfig';
import { DynamicRefreshSettings } from './config/RefreshSettings';

export { DynamicAudioSection } from './config/DynamicAudioSection';
export type { AudioDynamicConfig as DynamicAudioConfig } from './config/types';

// 按动态类型渲染不同的配置字段集合。
export function DynamicConfigForm({
  config,
  onChange,
  contentId,
}: {
  config: DynamicConfigT;
  onChange: (config: DynamicConfigT) => void;
  /** dashboard 用：展示 ingest URL（contentId 本身即 capability URL） */
  contentId?: string;
}) {
  switch (config.type) {
    case 'daily_calendar':
    case 'month_calendar':
      return null;
    case 'history_today':
      return <HistoryTodayConfigPanel config={config} onChange={onChange} />;
    case 'weather':
      return <WeatherConfigPanel config={config} onChange={onChange} />;
    case 'weather_alert':
      return <WeatherAlertConfigPanel config={config} onChange={onChange} />;
    case 'earthquake_report':
      return <DynamicRefreshSettings config={config} onChange={onChange} />;
    case 'dashboard':
      return <DashboardConfigPanel config={config} onChange={onChange} contentId={contentId} />;
    case 'font_test':
      return <FontTestConfigPanel config={config} onChange={onChange} />;
    case 'hot_list':
      return <HotListConfigPanel config={config} onChange={onChange} />;
    default:
      return <UnsupportedConfigNotice config={config} />;
  }
}

function UnsupportedConfigNotice({ config }: { config: DynamicConfigT }) {
  const type = (config as { type?: unknown }).type;
  return (
    <p className="font-sans text-[12px] text-stone">
      当前动态配置类型暂不支持编辑{typeof type === 'string' && type ? `：${type}` : ''}。
    </p>
  );
}
