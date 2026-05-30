import type { FormEvent, ReactNode } from 'react';
import { isAudioDynamicConfig, type DynamicConfigT, type DynamicTypeT } from 'shared';
import { Input } from '@/components/ui/Input';
import { FormSection } from '@/components/ui/FormSection';
import { DynamicConfigForm } from './DynamicConfigForm';
import { DynamicAudioSection } from './config/DynamicAudioSection';
import { DYNAMIC_TYPE_META } from '@/features/dynamic/model/type-meta';
import { cn } from '@/lib/cn';

export function DynamicContentFormShell({
  type,
  config,
  frameName,
  onFrameNameChange,
  onConfigChange,
  onSubmit,
  preview,
  header,
  actions,
  contentId,
  dashboardData,
  onDashboardDataChange,
  dashboardDataLabel,
  gridClassName,
}: {
  type: DynamicTypeT | null;
  config: DynamicConfigT | null;
  frameName: string;
  onFrameNameChange: (value: string) => void;
  onConfigChange: (config: DynamicConfigT) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  preview: ReactNode;
  header: ReactNode;
  actions: ReactNode;
  contentId?: string;
  dashboardData?: Record<string, unknown> | null;
  onDashboardDataChange?: (data: Record<string, unknown>) => void;
  dashboardDataLabel?: string;
  gridClassName?: string;
}) {
  const meta = type ? DYNAMIC_TYPE_META[type] : null;
  const showParams = type ? meta?.hasConfigurableParams : false;
  const showAudio = Boolean(type && meta?.supportsAudio && config && isAudioDynamicConfig(config));

  return (
    <form
      onSubmit={onSubmit}
      className={cn('grid grid-cols-1 gap-6 lg:gap-8', gridClassName ?? 'lg:grid-cols-[1.3fr_1fr]')}
    >
      <div className="order-2 min-w-0 lg:order-1">
        <p className="font-mono text-[10px] leading-5 text-stone uppercase tracking-[0.18em] ml-0.5 mb-2">
          设备预览
        </p>
        {preview}
      </div>

      <div className="order-1 min-w-0 lg:order-2 lg:mt-7 space-y-6">
        {header}

        {type && config && (
          <>
            {type === 'dashboard' && (
              <FormSection label="帧名称（选填，最多 64 字）">
                <Input
                  type="text"
                  maxLength={64}
                  value={frameName}
                  onChange={(event) => onFrameNameChange(event.target.value)}
                  placeholder="如：AI 使用统计"
                />
              </FormSection>
            )}

            {showParams && (
              <FormSection label="类型参数">
                <DynamicConfigForm
                  config={config}
                  onChange={onConfigChange}
                  contentId={contentId}
                  dashboardData={dashboardData ?? undefined}
                  onDashboardDataChange={type === 'dashboard' ? onDashboardDataChange : undefined}
                  dashboardDataLabel={dashboardDataLabel}
                />
              </FormSection>
            )}

            {showAudio && isAudioDynamicConfig(config) && (
              <FormSection label="音频">
                <DynamicAudioSection config={config} onChange={onConfigChange} />
              </FormSection>
            )}

            {actions}
          </>
        )}
      </div>
    </form>
  );
}
