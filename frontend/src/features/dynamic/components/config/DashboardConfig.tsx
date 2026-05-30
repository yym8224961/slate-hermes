import { useCallback } from 'react';
import {
  DASHBOARD_CUSTOM_STARTER_TEMPLATE,
  DashboardSystemTemplateId,
  DASHBOARD_SYSTEM_TEMPLATES,
  type DashboardTemplateT,
  type DynamicConfigT,
} from 'shared';
import {
  DASHBOARD_CUSTOM_STARTER_TEST_DATA,
  DASHBOARD_SYSTEM_TEMPLATE_TEST_DATA,
} from 'shared/dynamic/test-fixtures';
import { Select, SelectItem } from '@/components/ui/Select';
import { JsonEditor } from './JsonEditor';
import { DynamicRefreshSettings } from './RefreshSettings';
import { DashboardPushPanel } from './DashboardPushPanel';
import { parseDashboardTemplate, parseJsonRecord } from '@/features/dynamic/model/json';
import type { DynamicConfigChange } from '@/features/dynamic/types';
import { useJsonDraftWithEcho } from '@/features/dynamic/hooks/useJsonDraftWithEcho';

const CUSTOM_DASHBOARD_TEMPLATE_VALUE = 'custom';
const DASHBOARD_SYSTEM_TEMPLATE_OPTIONS = Object.values(DASHBOARD_SYSTEM_TEMPLATES);

export function DashboardConfigPanel({
  config,
  onChange,
  dashboardData,
  onDashboardDataChange,
  dataLabel = onDashboardDataChange ? '初始数据 JSON' : '当前数据 JSON',
  contentId,
}: {
  config: Extract<DynamicConfigT, { type: 'dashboard' }>;
  onChange: DynamicConfigChange;
  dashboardData: Record<string, unknown>;
  onDashboardDataChange?: (data: Record<string, unknown>) => void;
  dataLabel?: string;
  contentId?: string;
}) {
  const templateSelection =
    config.template.kind === 'system' ? config.template.id : CUSTOM_DASHBOARD_TEMPLATE_VALUE;
  const customTemplate = config.template.kind === 'custom' ? config.template.template : null;
  const activeDescription =
    config.template.kind === 'custom'
      ? '编辑 JSON 模板；数据由新建初始数据或推送接口提供，模板保存在内容配置中。'
      : DASHBOARD_SYSTEM_TEMPLATES[config.template.id].description;
  const updateCustomTemplate = useCallback(
    (template: DashboardTemplateT) => {
      onChange({ ...config, template: { kind: 'custom', template } });
    },
    [config, onChange]
  );
  const updateDashboardData = useCallback(
    (data: Record<string, unknown>) => {
      onDashboardDataChange?.(data);
    },
    [onDashboardDataChange]
  );
  const templateDraft = useJsonDraftWithEcho({
    value: customTemplate,
    fallback: DASHBOARD_CUSTOM_STARTER_TEMPLATE,
    parse: parseDashboardTemplateDraft,
    onValidChange: updateCustomTemplate,
  });
  const dashboardDataDraft = useJsonDraftWithEcho({
    value: dashboardData,
    fallback: DASHBOARD_CUSTOM_STARTER_TEST_DATA,
    parse: parseJsonRecord,
    onValidChange: updateDashboardData,
  });

  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">模板</p>
        <Select
          value={templateSelection}
          onValueChange={(value) => {
            if (value === CUSTOM_DASHBOARD_TEMPLATE_VALUE) {
              const parsed = parseDashboardTemplate(templateDraft.text);
              const template = parsed.ok ? parsed.template : DASHBOARD_CUSTOM_STARTER_TEMPLATE;
              onChange({
                ...config,
                template: { kind: 'custom', template },
              });
              if (config.template.kind !== 'custom') {
                onDashboardDataChange?.({ ...DASHBOARD_CUSTOM_STARTER_TEST_DATA });
              }
              templateDraft.setError(parsed.ok ? null : parsed.error);
            } else {
              const parsedId = DashboardSystemTemplateId.safeParse(value);
              if (!parsedId.success) return;
              const id = parsedId.data;
              onChange({
                ...config,
                template: { kind: 'system', id },
              });
              onDashboardDataChange?.({ ...DASHBOARD_SYSTEM_TEMPLATE_TEST_DATA[id] });
              templateDraft.setError(null);
            }
          }}
        >
          <SelectItem value={CUSTOM_DASHBOARD_TEMPLATE_VALUE} hint="JSON">
            自定义模板
          </SelectItem>
          {DASHBOARD_SYSTEM_TEMPLATE_OPTIONS.map((item) => (
            <SelectItem key={item.id} value={item.id} hint="内置">
              {item.label}
            </SelectItem>
          ))}
        </Select>
        <p className="mt-2 font-sans text-[11px] text-stone leading-snug">{activeDescription}</p>
      </div>

      <DynamicRefreshSettings config={config} onChange={onChange} />

      {templateSelection === CUSTOM_DASHBOARD_TEMPLATE_VALUE && (
        <JsonEditor
          label="自定义模板 JSON"
          value={templateDraft.text}
          error={templateDraft.error}
          minRows={8}
          onChange={templateDraft.updateDraft}
        />
      )}

      <JsonEditor
        label={dataLabel}
        value={dashboardDataDraft.text}
        error={dashboardDataDraft.error}
        minRows={6}
        onChange={onDashboardDataChange ? dashboardDataDraft.updateDraft : undefined}
        readOnly={!onDashboardDataChange}
      />

      {contentId && <DashboardPushPanel contentId={contentId} data={dashboardData} />}
    </div>
  );
}

function parseDashboardTemplateDraft(
  text: string
): { ok: true; data: DashboardTemplateT } | { ok: false; error: string } {
  const parsed = parseDashboardTemplate(text);
  return parsed.ok ? { ok: true, data: parsed.template } : parsed;
}
