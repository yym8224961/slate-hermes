import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import {
  DASHBOARD_CUSTOM_STARTER_TEMPLATE,
  DASHBOARD_CUSTOM_STARTER_TEST_DATA,
  DASHBOARD_SYSTEM_TEMPLATES,
  DashboardTemplate,
  FONT_TEST_FONTS,
  HOT_LIST_SOURCES_BY_NAME,
  TTS_VOICES,
  WEATHER_ALERT_PROVINCES,
  hotListSourceDisplayLabel,
  isWeatherAlertProvince,
  normalizeWeatherAlertProvince,
  type CurrentHotListSourceIdT,
  type DashboardSystemTemplateIdT,
  type DashboardTemplateT,
  type DynamicConfigT,
  type FontTestFontIdT,
  type TtsVoiceT,
} from 'shared';
import { inputCls, fieldBaseCls } from '@/lib/styles';
import { searchCities } from '@/lib/cities';
import { Select, SelectItem } from '@/components/ui/Select';
import { cn } from '@/lib/cn';

const WEATHER_ALERT_REGIONS: Array<{ label: string; value: string; hint?: string }> = [
  { label: '全国', value: '', hint: '全部预警' },
  ...WEATHER_ALERT_PROVINCES.map((province) => ({
    label: province,
    value: province,
    hint: province.endsWith('市') ? '直辖市' : undefined,
  })),
];

const CUSTOM_DASHBOARD_TEMPLATE_VALUE = 'custom';
const DASHBOARD_SYSTEM_TEMPLATE_OPTIONS = Object.values(DASHBOARD_SYSTEM_TEMPLATES);

// 按动态类型渲染不同的配置字段集合。
export function DynamicConfigForm({
  config,
  onChange,
  contentId,
}: {
  config: DynamicConfigT;
  onChange: (c: DynamicConfigT) => void;
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
    case 'weather_alert':
      return <WeatherAlertConfigPanel config={config} onChange={onChange} />;
    case 'earthquake_report':
      return <DynamicRefreshSettings config={config} onChange={onChange} />;
    case 'dashboard':
      return <DashboardConfigPanel config={config} onChange={onChange} contentId={contentId} />;
    case 'font_test': {
      const font = FONT_TEST_FONTS.find((item) => item.id === config.font_id);
      return (
        <div className="space-y-4">
          <div>
            <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
              字体
            </p>
            <Select
              value={config.font_id}
              onValueChange={(v) => {
                onChange({
                  ...config,
                  font_id: v as FontTestFontIdT,
                });
              }}
            >
              {FONT_TEST_FONTS.map((font) => (
                <SelectItem key={font.id} value={font.id} hint={font.hint}>
                  {font.label}
                </SelectItem>
              ))}
            </Select>
          </div>
          {font && (
            <div className="space-y-1.5">
              <p className="font-sans text-[12px] text-stone leading-relaxed italic">{font.note}</p>
              <p className="mt-1.5 font-mono text-[10px] text-stone truncate">
                {font.source} · {font.license}
              </p>
            </div>
          )}
          <Checkbox
            label="反白测试"
            checked={config.invert}
            onChange={(v) => onChange({ ...config, invert: v })}
          />
        </div>
      );
    }
    case 'hot_list':
      return <HotListConfigPanel config={config} onChange={onChange} />;
    default:
      return <UnsupportedConfigNotice config={config} />;
  }
}

// ─── 私有辅助组件 ──────────────────────────────────────────────────────────────

type AudioDynamicConfig = Extract<
  DynamicConfigT,
  {
    type:
      | 'daily_calendar'
      | 'month_calendar'
      | 'weather'
      | 'history_today'
      | 'weather_alert'
      | 'earthquake_report';
  }
>;

export function DynamicAudioSection({
  config,
  onChange,
}: {
  config: AudioDynamicConfig;
  onChange: (c: DynamicConfigT) => void;
}) {
  return (
    <div className="space-y-3">
      <Checkbox
        label="生成音频"
        checked={config.audio_enabled}
        onChange={(v) => onChange({ ...config, audio_enabled: v })}
      />
      <div>
        <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">音色</p>
        <Select
          value={config.audio_voice}
          onValueChange={(v) => onChange({ ...config, audio_voice: v as TtsVoiceT })}
          disabled={!config.audio_enabled}
        >
          {TTS_VOICES.map((voice) => (
            <SelectItem key={voice} value={voice}>
              {voice}
            </SelectItem>
          ))}
        </Select>
      </div>
    </div>
  );
}

export type DynamicAudioConfig = AudioDynamicConfig;

function DynamicRefreshSettings({
  config,
  onChange,
}: {
  config:
    | AudioDynamicConfig
    | Extract<
        DynamicConfigT,
        { type: 'hot_list' | 'weather_alert' | 'earthquake_report' | 'dashboard' }
      >;
  onChange: (c: DynamicConfigT) => void;
}) {
  const current = config.refresh_interval_sec ?? defaultRefreshInterval(config.type);
  return (
    <div>
      <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
        刷新间隔
      </p>
      <Select
        value={String(current)}
        onValueChange={(v) => onChange({ ...config, refresh_interval_sec: Number(v) })}
      >
        {refreshOptions(config.type).map((item) => (
          <SelectItem key={item.value} value={String(item.value)} hint={item.hint}>
            {item.label}
          </SelectItem>
        ))}
      </Select>
    </div>
  );
}

function HistoryTodayConfigPanel({
  config,
  onChange,
}: {
  config: Extract<DynamicConfigT, { type: 'history_today' }>;
  onChange: (c: DynamicConfigT) => void;
}) {
  return (
    <div>
      <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">数据源</p>
      <Select
        value={config.source}
        onValueChange={(v) =>
          onChange({ ...config, source: v as Extract<typeof config.source, string> })
        }
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

function WeatherAlertConfigPanel({
  config,
  onChange,
}: {
  config: Extract<DynamicConfigT, { type: 'weather_alert' }>;
  onChange: (c: DynamicConfigT) => void;
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

function HotListConfigPanel({
  config,
  onChange,
}: {
  config: Extract<DynamicConfigT, { type: 'hot_list' }>;
  onChange: (c: DynamicConfigT) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">频道</p>
        <Select
          value={config.source}
          onValueChange={(v) => onChange({ ...config, source: v as CurrentHotListSourceIdT })}
        >
          {HOT_LIST_SOURCES_BY_NAME.map((source) => (
            <SelectItem key={source.id} value={source.id} hint={hotListKindLabel(source.kind)}>
              {hotListSourceDisplayLabel(source)}
            </SelectItem>
          ))}
        </Select>
      </div>
      <DynamicRefreshSettings config={config} onChange={onChange} />
    </div>
  );
}

function hotListKindLabel(kind: (typeof HOT_LIST_SOURCES_BY_NAME)[number]['kind']): string {
  switch (kind) {
    case 'general':
      return '综合';
    case 'news':
      return '新闻';
    case 'tech':
      return '科技';
    case 'community':
      return '社区';
    case 'commerce':
      return '消费';
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

function DashboardConfigPanel({
  config,
  onChange,
  contentId,
}: {
  config: Extract<DynamicConfigT, { type: 'dashboard' }>;
  onChange: (c: DynamicConfigT) => void;
  contentId?: string;
}) {
  const templateSelection =
    config.template.kind === 'system' ? config.template.id : CUSTOM_DASHBOARD_TEMPLATE_VALUE;
  const customTemplate = config.template.kind === 'custom' ? config.template.template : null;
  const activeDescription =
    config.template.kind === 'custom'
      ? '编辑 JSON 模板和测试数据；推送接口只接收 version + data，模板保存在内容配置中。'
      : DASHBOARD_SYSTEM_TEMPLATES[config.template.id].description;
  const [customTemplateText, setCustomTemplateText] = useState(() =>
    JSON.stringify(
      config.template.kind === 'custom' ? config.template.template : DASHBOARD_CUSTOM_STARTER_TEMPLATE,
      null,
      2
    )
  );
  const [testDataText, setTestDataText] = useState(() => JSON.stringify(config.test_data, null, 2));
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const localTemplateKeyRef = useRef<string | null>(null);
  const localTestDataKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = stableJson(config.test_data);
    if (localTestDataKeyRef.current === key) {
      localTestDataKeyRef.current = null;
      return;
    }
    setTestDataText(JSON.stringify(config.test_data, null, 2));
    setDataError(null);
  }, [config.test_data]);

  useEffect(() => {
    if (!customTemplate) return;
    const key = stableJson(customTemplate);
    if (localTemplateKeyRef.current === key) {
      localTemplateKeyRef.current = null;
      return;
    }
    setCustomTemplateText(JSON.stringify(customTemplate, null, 2));
    setTemplateError(null);
  }, [customTemplate]);

  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
          模板
        </p>
        <Select
          value={templateSelection}
          onValueChange={(v) => {
            if (v === CUSTOM_DASHBOARD_TEMPLATE_VALUE) {
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
              const id = v as DashboardSystemTemplateIdT;
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
        <p className="mt-2 font-sans text-[11px] text-stone leading-snug">
          {activeDescription}
        </p>
      </div>

      <DynamicRefreshSettings config={config} onChange={onChange} />

      {templateSelection === CUSTOM_DASHBOARD_TEMPLATE_VALUE && (
        <JsonEditor
          label="自定义模板 JSON"
          value={customTemplateText}
          error={templateError}
          minRows={8}
          onChange={(text) => {
            setCustomTemplateText(text);
            const parsed = parseDashboardTemplate(text);
            setTemplateError(parsed.ok ? null : parsed.error);
            if (parsed.ok) {
              localTemplateKeyRef.current = stableJson(parsed.template);
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
          setTestDataText(text);
          const parsed = parseJsonRecord(text);
          setDataError(parsed.ok ? null : parsed.error);
          if (parsed.ok) {
            localTestDataKeyRef.current = stableJson(parsed.data);
            onChange({ ...config, test_data: parsed.data });
          }
        }}
      />

      {contentId && <DashboardPushPanel contentId={contentId} config={config} />}
    </div>
  );
}

function CitySearch({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (r: { locationId: string; label: string }) => void;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setQuery(value);
    setDirty(false);
    setOpen(false);
  }, [value]);

  const results = useMemo(
    () => (dirty && query.trim() ? searchCities(query.trim()).slice(0, 8) : []),
    [dirty, query]
  );

  useEffect(() => {
    if (results.length > 0) setOpen(true);
    else if (dirty) setOpen(false);
  }, [dirty, results.length]);

  const noResult = dirty && query.trim().length > 0 && results.length === 0;

  return (
    <div className="relative">
      <label className="block">
        <span className="block font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
          城市
        </span>
        <input
          className={cn(inputCls, 'w-full')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setDirty(true);
          }}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="输入城市名或省份名，如：长沙、广东"
          autoComplete="off"
        />
      </label>
      {noResult && (
        <p className="font-sans text-[11px] text-stone mt-1.5">未找到此城市，支持省份名搜索</p>
      )}
      {open && results.length > 0 && (
        <div className="absolute z-10 top-full mt-1 left-0 right-0 border border-ink bg-paper shadow">
          {results.map((r) => (
            <button
              key={`${r.name}-${r.province}`}
              type="button"
              className="w-full text-left px-3 py-2 font-sans text-[13px] text-ink hover:bg-cream"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelect({ locationId: r.locationId, label: r.name });
                setQuery(r.name);
                setDirty(false);
                setOpen(false);
              }}
            >
              {r.name}
              {r.province !== r.name && (
                <span className="ml-2 text-stone text-[11px]">{r.province}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProvinceSearch({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (province: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState(value ? regionLabel(value) : '');
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (focused) return;
    setQuery(value ? regionLabel(value) : '');
    setDirty(false);
    setOpen(false);
  }, [focused, value]);

  const results = useMemo(() => (dirty ? searchWeatherAlertRegions(query) : []), [dirty, query]);

  useEffect(() => {
    if (results.length > 0) setOpen(true);
    else if (dirty) setOpen(false);
  }, [dirty, results.length]);

  return (
    <div className="relative">
      <label className="block">
        <span className="block font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
          区域
        </span>
        <input
          className={cn(inputCls, 'w-full')}
          value={query}
          onChange={(e) => {
            const next = e.target.value;
            const normalized = regionValueFromInput(next);
            setQuery(next);
            setDirty(true);
            if (isWeatherAlertRegionValue(normalized)) onSelect(normalized);
          }}
          onFocus={() => {
            setFocused(true);
            setDirty(true);
            setOpen(true);
          }}
          onBlur={() =>
            setTimeout(() => {
              const next = regionValueFromInput(query);
              const normalized = isWeatherAlertRegionValue(next) ? next : value;
              onSelect(normalized);
              setQuery(normalized ? regionLabel(normalized) : '');
              setFocused(false);
              setDirty(false);
              setOpen(false);
            }, 150)
          }
          placeholder="全国或省级区域，如：广东省"
          autoComplete="off"
        />
      </label>
      {open && results.length > 0 && (
        <div className="absolute z-10 top-full mt-1 left-0 right-0 max-h-64 overflow-y-auto overscroll-contain border border-ink bg-paper shadow">
          {results.map((region) => (
            <button
              key={region.label}
              type="button"
              className="w-full text-left px-3 py-2 font-sans text-[13px] text-ink hover:bg-cream"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelect(region.value);
                setQuery(region.label);
                setDirty(false);
                setOpen(false);
              }}
            >
              {region.label}
              {region.hint && <span className="ml-2 text-stone text-[11px]">{region.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 accent-ink"
      />
      <span className="font-sans text-[13px] text-ink">{label}</span>
    </label>
  );
}

function JsonEditor({
  label,
  value,
  error,
  minRows,
  onChange,
}: {
  label: string;
  value: string;
  error: string | null;
  minRows: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="block font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
        {label}
      </span>
      <textarea
        className={cn(
          fieldBaseCls,
          'block w-full resize-y font-mono text-[11px] leading-relaxed px-2 py-2 border border-ink bg-cream/30'
        )}
        rows={minRows}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <p className="mt-1.5 font-sans text-[11px] text-red-700">{error}</p>}
    </label>
  );
}

function parseDashboardTemplate(
  text: string
): { ok: true; template: DashboardTemplateT } | { ok: false; error: string } {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const template = DashboardTemplate.safeParse(parsed.data);
  if (!template.success) {
    return { ok: false, error: template.error.issues[0]?.message ?? '模板格式非法' };
  }
  return { ok: true, template: template.data };
}

function parseJsonRecord(
  text: string
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    return { ok: false, error: '必须是 JSON object' };
  }
  return { ok: true, data: parsed.data as Record<string, unknown> };
}

function parseJson(text: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'JSON 解析失败' };
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function defaultRefreshInterval(
  _type: AudioDynamicConfig['type'] | 'hot_list' | 'weather_alert' | 'earthquake_report' | 'dashboard'
): number {
  return 600;
}

function regionLabel(value: string): string {
  const normalized = normalizeWeatherAlertProvince(value);
  if (!normalized) return '全国';
  return WEATHER_ALERT_REGIONS.find((region) => region.value === normalized)?.label ?? value;
}

function regionValueFromInput(value: string): string {
  return normalizeWeatherAlertProvince(value);
}

function isWeatherAlertRegionValue(value: string): boolean {
  return value === '' || isWeatherAlertProvince(value);
}

function searchWeatherAlertRegions(query: string): typeof WEATHER_ALERT_REGIONS {
  const q = query.trim();
  if (!q || q === '全国') return WEATHER_ALERT_REGIONS;
  const normalizedQuery = normalizeWeatherAlertProvince(q);
  return WEATHER_ALERT_REGIONS.filter((region) => {
    const normalized = region.label.replace(/省|市|自治区|特别行政区|壮族|回族|维吾尔/g, '');
    return (
      region.label.includes(q) ||
      region.value.includes(q) ||
      region.value === normalizedQuery ||
      normalized.includes(q)
    );
  });
}

function refreshOptions(type?: string): Array<{
  value: number;
  label: string;
  hint: string;
}> {
  return [
    ...(type === 'dashboard' ? [{ value: 60, label: '1 分钟', hint: '高频' }] : []),
    { value: 300, label: '5 分钟', hint: '更实时' },
    { value: 600, label: '10 分钟', hint: '推荐' },
    { value: 1800, label: '30 分钟', hint: '省电' },
    { value: 3600, label: '1 小时', hint: '低频' },
  ];
}

function DashboardPushPanel({
  contentId,
  config,
}: {
  contentId: string;
  config: Extract<DynamicConfigT, { type: 'dashboard' }>;
}) {
  const [copied, setCopied] = useState(false);
  const url = useMemo(
    () => `${window.location.origin}/api/v1/contents/${contentId}/data`,
    [contentId]
  );
  const examplePayload = useMemo(() => {
    return { version: 1, data: config.test_data };
  }, [config]);
  const exampleCurl = useMemo(
    () =>
      `curl -X POST -H 'Content-Type: application/json' --data-binary @- \\\n  ${url} <<'JSON'\n${JSON.stringify(examplePayload, null, 2)}\nJSON`,
    [examplePayload, url]
  );
  function copy() {
    void navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="space-y-3">
      <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em]">数据推送 URL</p>
      <div className="flex gap-2 items-start">
        <code className={`${fieldBaseCls} ${inputCls} text-[11px] break-all flex-1 py-1.5`}>
          {url}
        </code>
        <button
          type="button"
          onClick={copy}
          className="px-2 py-1.5 text-stone hover:text-ink hover:bg-cream border border-ink flex-shrink-0"
          title="复制"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <details className="text-[11px]">
        <summary className="font-mono text-stone uppercase tracking-[0.12em] cursor-pointer">
          示例 curl
        </summary>
        <pre className="mt-2 p-3 bg-cream border border-line text-[10px] leading-snug overflow-x-auto whitespace-pre-wrap">
          {exampleCurl}
        </pre>
      </details>
      <p className="font-sans text-[11px] text-stone italic leading-snug">
        推送流程：① 复制 URL → ② 由你的系统/脚本 POST 数据 → ③ 设备下次唤醒时拉取并刷新屏幕。 URL
        中的 contentId 即推送凭证（cuid 不可枚举），请勿公开分享，泄漏后只能删内容重建。
        推送后不会立即亮屏，设备按预设周期或按键翻页时生效。
      </p>
    </div>
  );
}
