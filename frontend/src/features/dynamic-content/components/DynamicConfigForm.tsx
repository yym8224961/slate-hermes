import { useEffect, useMemo, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { FONT_TEST_FONTS, type DynamicConfigT, type FontTestFontIdT } from 'shared';
import { inputCls, fieldBaseCls } from '@/lib/styles';
import { searchCities } from '@/lib/cities';
import { Select, SelectItem } from '@/components/ui/Select';

// 按动态类型渲染不同的配置字段集合。
export function DynamicConfigForm({
  config,
  onChange,
  contentId,
}: {
  config: DynamicConfigT;
  onChange: (c: DynamicConfigT) => void;
  /** dashboard 用：展示 ingest URL */
  contentId?: string;
}) {
  switch (config.type) {
    case 'daily_calendar':
    case 'month_calendar':
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
          <p className="font-mono text-[10px] text-stone">QWeather · {config.location_id}</p>
          <div>
            <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
              温度单位
            </p>
            <div className="flex gap-6">
              <Radio
                label="°C（摄氏）"
                checked={config.units === 'metric'}
                onChange={() => onChange({ ...config, units: 'metric' })}
              />
              <Radio
                label="°F（华氏）"
                checked={config.units === 'imperial'}
                onChange={() => onChange({ ...config, units: 'imperial' })}
              />
            </div>
          </div>
          <p className="font-sans text-[11px] text-stone italic">
            天气数据来自 QWeather，需要后端配置 QWEATHER_API_KEY 和 QWEATHER_API_HOST。
          </p>
        </div>
      );
    case 'history_today':
      return (
        <div className="space-y-4">
          <p className="font-sans text-[13px] text-stone">
            自动显示今日历史事件，数据来自维基百科中文版。
          </p>
        </div>
      );
    case 'dashboard':
      return (
        <div className="space-y-4">
          {contentId && <DashboardPushPanel contentId={contentId} />}
          {!contentId && (
            <p className="font-sans text-[11px] text-stone italic">
              创建后这里会显示「数据推送 URL」与示例 curl。
            </p>
          )}
        </div>
      );
    case 'font_test':
      return (
        <div className="space-y-4">
          <div>
            <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
              字体
            </p>
            <Select
              value={config.font_id}
              onValueChange={(v) => {
                const font = FONT_TEST_FONTS.find((item) => item.id === v);
                const nextLayout =
                  font?.kind === 'icon'
                    ? 'icons'
                    : config.layout === 'icons'
                      ? 'specimen'
                      : config.layout;
                onChange({
                  ...config,
                  font_id: v as FontTestFontIdT,
                  sample_text: font?.sampleText ?? config.sample_text,
                  layout: nextLayout,
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
          <div>
            <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
              版式
            </p>
            <div className="flex flex-wrap gap-5">
              <Radio
                label="标本"
                checked={config.layout === 'specimen'}
                onChange={() => onChange({ ...config, layout: 'specimen' })}
              />
              <Radio
                label="段落"
                checked={config.layout === 'paragraph'}
                onChange={() => onChange({ ...config, layout: 'paragraph' })}
              />
              <Radio
                label="数字"
                checked={config.layout === 'numbers'}
                onChange={() => onChange({ ...config, layout: 'numbers' })}
              />
              <Radio
                label="图标"
                checked={config.layout === 'icons'}
                onChange={() => onChange({ ...config, layout: 'icons' })}
              />
            </div>
          </div>
          <label className="block">
            <span className="block font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">
              样本文本
            </span>
            <textarea
              className={`${inputCls} min-h-28 resize-y leading-snug`}
              maxLength={240}
              value={config.sample_text}
              onChange={(e) => onChange({ ...config, sample_text: e.target.value })}
              placeholder="输入要测试的中文、英文、数字或符号"
            />
            <span className="block font-sans text-[11px] text-stone mt-1.5">
              {config.sample_text.length}/240
            </span>
          </label>
          <Checkbox
            label="反白测试"
            checked={config.invert}
            onChange={(v) => onChange({ ...config, invert: v })}
          />
        </div>
      );
    default:
      return <UnsupportedConfigNotice config={config} />;
  }
}

// ─── 私有辅助组件 ──────────────────────────────────────────────────────────────

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
          className={`${inputCls} w-full`}
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

function Radio({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <input type="radio" checked={checked} onChange={onChange} className="w-4 h-4 accent-ink" />
      <span className="font-sans text-[13px] text-ink">{label}</span>
    </label>
  );
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
    <div className="space-y-3 border-t border-line pt-4">
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
        推送流程：① 复制 URL → ② 由你的系统/脚本 POST 数据 → ③ 设备下次唤醒时拉取并刷新屏幕。
        content id
        本身即令牌（cuid），请勿公开。推送后不会立即亮屏，设备按预设周期或按键翻页时生效。
      </p>
    </div>
  );
}
