import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DASHBOARD_CUSTOM_STARTER_TEMPLATE,
  DASHBOARD_CUSTOM_STARTER_TEST_DATA,
  DashboardSystemTemplateId,
  DASHBOARD_SYSTEM_TEMPLATES,
  type DynamicConfigT,
} from 'shared';
import { Select, SelectItem } from '@/components/ui/Select';
import { JsonEditor } from './JsonEditor';
import { DynamicRefreshSettings } from './RefreshSettings';
import { DashboardPushPanel } from './DashboardPushPanel';
import { canonicalJsonKey, parseDashboardTemplate, parseJsonRecord } from '@/lib/json';
import type { DynamicConfigChange } from '@/features/dynamic/types';

const CUSTOM_DASHBOARD_TEMPLATE_VALUE = 'custom';
const DASHBOARD_SYSTEM_TEMPLATE_OPTIONS = Object.values(DASHBOARD_SYSTEM_TEMPLATES);

export function DashboardConfigPanel({
  config,
  onChange,
  contentId,
}: {
  config: Extract<DynamicConfigT, { type: 'dashboard' }>;
  onChange: DynamicConfigChange;
  contentId?: string;
}) {
  const templateSelection =
    config.template.kind === 'system' ? config.template.id : CUSTOM_DASHBOARD_TEMPLATE_VALUE;
  const customTemplate = config.template.kind === 'custom' ? config.template.template : null;
  const testDataKey = useMemo(() => canonicalJsonKey(config.test_data), [config.test_data]);
  const customTemplateKey = useMemo(
    () => (customTemplate ? canonicalJsonKey(customTemplate) : null),
    [customTemplate]
  );
  const activeDescription =
    config.template.kind === 'custom'
      ? '编辑 JSON 模板和测试数据；推送接口只接收 version + data，模板保存在内容配置中。'
      : DASHBOARD_SYSTEM_TEMPLATES[config.template.id].description;
  const [customTemplateText, setCustomTemplateText] = useState(() =>
    JSON.stringify(
      config.template.kind === 'custom'
        ? config.template.template
        : DASHBOARD_CUSTOM_STARTER_TEMPLATE,
      null,
      2
    )
  );
  const [testDataText, setTestDataText] = useState(() => JSON.stringify(config.test_data, null, 2));
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const customTemplateTextRef = useRef(customTemplateText);
  const testDataTextRef = useRef(testDataText);

  function setCustomTemplateDraft(text: string) {
    customTemplateTextRef.current = text;
    setCustomTemplateText(text);
  }

  function setTestDataDraft(text: string) {
    testDataTextRef.current = text;
    setTestDataText(text);
  }

  useEffect(() => {
    const local = parseJsonRecord(testDataTextRef.current);
    if (local.ok && canonicalJsonKey(local.data) === testDataKey) {
      setDataError(null);
      return;
    }
    setTestDataDraft(JSON.stringify(config.test_data, null, 2));
    setDataError(null);
  }, [config.test_data, testDataKey]);

  useEffect(() => {
    if (!customTemplate || !customTemplateKey) return;
    const local = parseDashboardTemplate(customTemplateTextRef.current);
    if (local.ok && canonicalJsonKey(local.template) === customTemplateKey) {
      setTemplateError(null);
      return;
    }
    setCustomTemplateDraft(JSON.stringify(customTemplate, null, 2));
    setTemplateError(null);
  }, [customTemplate, customTemplateKey]);

  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">模板</p>
        <Select
          value={templateSelection}
          onValueChange={(value) => {
            if (value === CUSTOM_DASHBOARD_TEMPLATE_VALUE) {
              const parsed = parseDashboardTemplate(customTemplateText);
              const template = parsed.ok ? parsed.template : DASHBOARD_CUSTOM_STARTER_TEMPLATE;
              onChange({
                ...config,
                template: { kind: 'custom', template },
                test_data:
                  config.template.kind === 'custom'
                    ? config.test_data
                    : DASHBOARD_CUSTOM_STARTER_TEST_DATA,
              });
              setTemplateError(parsed.ok ? null : parsed.error);
            } else {
              const parsedId = DashboardSystemTemplateId.safeParse(value);
              if (!parsedId.success) return;
              const id = parsedId.data;
              const system = DASHBOARD_SYSTEM_TEMPLATES[id];
              onChange({
                ...config,
                template: { kind: 'system', id },
                test_data: system.test_data,
              });
              setTemplateError(null);
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
          value={customTemplateText}
          error={templateError}
          minRows={8}
          onChange={(text) => {
            setCustomTemplateDraft(text);
            const parsed = parseDashboardTemplate(text);
            setTemplateError(parsed.ok ? null : parsed.error);
            if (parsed.ok) {
              onChange({ ...config, template: { kind: 'custom', template: parsed.template } });
            }
          }}
        />
      )}

      <JsonEditor
        label="测试数据 JSON"
        value={testDataText}
        error={dataError}
        minRows={6}
        onChange={(text) => {
          setTestDataDraft(text);
          const parsed = parseJsonRecord(text);
          setDataError(parsed.ok ? null : parsed.error);
          if (parsed.ok) {
            onChange({ ...config, test_data: parsed.data });
          }
        }}
      />

      {contentId && <DashboardPushPanel contentId={contentId} config={config} />}
    </div>
  );
}
