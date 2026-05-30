import type { DynamicConfigT } from 'shared';
import { DynamicConfigBoundary } from './DynamicConfigBoundary';
import { DynamicConfigPanel } from '@/features/dynamic/model/config-panels';

// 按动态类型渲染不同的配置字段集合。
export function DynamicConfigForm({
  config,
  onChange,
  contentId,
  dashboardData,
  onDashboardDataChange,
  dashboardDataLabel,
}: {
  config: DynamicConfigT;
  onChange: (config: DynamicConfigT) => void;
  /** dashboard 用：展示 ingest URL（contentId 本身即 capability URL） */
  contentId?: string;
  dashboardData?: Record<string, unknown>;
  onDashboardDataChange?: (data: Record<string, unknown>) => void;
  dashboardDataLabel?: string;
}) {
  return (
    <DynamicConfigBoundary resetKey={`${config.type}:${contentId ?? ''}`}>
      <DynamicConfigPanel
        config={config}
        onChange={onChange}
        contentId={contentId}
        dashboardData={dashboardData}
        onDashboardDataChange={onDashboardDataChange}
        dashboardDataLabel={dashboardDataLabel}
      />
    </DynamicConfigBoundary>
  );
}
