import { useEffect, useMemo, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import {
  FONT_TEST_FONTS,
  HOT_LIST_SOURCES,
  TTS_VOICES,
  type DynamicConfigT,
  type FontTestFontIdT,
  type HotListSourceIdT,
  type TtsVoiceT,
} from 'shared';
import { inputCls, fieldBaseCls } from '@/lib/styles';
import { searchCities } from '@/lib/cities';
import { Select, SelectItem } from '@/components/ui/Select';
import { cn } from '@/lib/cn';

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
    case 'history_today':
      return null;
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
    case 'dashboard':
      return contentId ? <DashboardPushPanel contentId={contentId} /> : null;
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
  { type: 'daily_calendar' | 'month_calendar' | 'weather' | 'history_today' }
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
  config: AudioDynamicConfig | Extract<DynamicConfigT, { type: 'hot_list' }>;
  onChange: (c: DynamicConfigT) => void;
}) {
  const current = config.refresh_interval_sec ?? defaultRefreshInterval(config.type);
  return (
    <div>
      <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
        数据刷新
      </p>
      <Select
        value={String(current)}
        onValueChange={(v) => onChange({ ...config, refresh_interval_sec: Number(v) })}
      >
        {refreshOptions().map((item) => (
          <SelectItem key={item.value} value={String(item.value)} hint={item.hint}>
            {item.label}
          </SelectItem>
        ))}
      </Select>
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
          onValueChange={(v) => onChange({ ...config, source: v as HotListSourceIdT })}
        >
          {HOT_LIST_SOURCES.map((source) => (
            <SelectItem key={source.id} value={source.id} hint={hotListKindLabel(source.kind)}>
              {source.label}
            </SelectItem>
          ))}
        </Select>
      </div>
      <DynamicRefreshSettings config={config} onChange={onChange} />
    </div>
  );
}

function hotListKindLabel(kind: (typeof HOT_LIST_SOURCES)[number]['kind']): string {
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

function defaultRefreshInterval(_type: AudioDynamicConfig['type'] | 'hot_list'): number {
  return 600;
}

function refreshOptions(): Array<{
  value: number;
  label: string;
  hint: string;
}> {
  return [
    { value: 300, label: '5 分钟', hint: '更实时' },
    { value: 600, label: '10 分钟', hint: '推荐' },
    { value: 1800, label: '30 分钟', hint: '省电' },
    { value: 3600, label: '1 小时', hint: '低频' },
  ];
}

function DashboardPushPanel({ contentId }: { contentId: string }) {
  const [copied, setCopied] = useState(false);
  const url = useMemo(
    () => `${window.location.origin}/api/v1/contents/${contentId}/data`,
    [contentId]
  );
  const exampleCurl = useMemo(
    () =>
      `curl -X POST -H 'Content-Type: application/json' \\\n  -d '{"heading":"销售","metrics":{"today":1234,"yesterday":1100}}' \\\n  ${url}`,
    [url]
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
