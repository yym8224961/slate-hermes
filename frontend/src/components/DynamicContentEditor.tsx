// 动态内容编辑器 —— 创建 + 编辑共用。
//
// 创建：选类型 → 填配置 → 保存（POST /groups/:gid/contents/dynamic）
// 编辑：直接进配置面板（type 不可改）→ 保存（PATCH /contents/:contentId）

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Sparkles, Copy, Check } from 'lucide-react';
import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  DynamicConfig,
  type ContentSummaryT,
  type DynamicConfigT,
  type DynamicTypeT,
} from 'shared';
import {
  useContentImage,
  useCreateDynamicContent,
  usePreviewDynamicContent,
  useUpdateContentAudio,
  useUpdateDynamicContent,
} from '../lib/queries';
import { useToast } from './Toast';
import { Input } from './Input';
import { Button } from './Button';
import { Spinner } from './Spinner';
import { IconBlock } from './IconBlock';
import { DoubleRule } from './DoubleRule';
import { DynamicTypePicker } from './DynamicTypePicker';
import { decodeBppImage, isValidBppLength } from '../lib/image';
import { inputCls, fieldBaseCls } from '../lib/styles';
import { StatusBarOverlay } from './StatusBarOverlay';
import { searchCities } from '../lib/cities';
import { getApiErrorMessage } from '../lib/api-error';
import { AudioDropzone } from './image-content-editor-controls/AudioDropzone';

interface DynamicContentEditorProps {
  gid: string;
  /** edit 模式传现有动态内容；create 不传 */
  content?: ContentSummaryT;
  /** edit 模式下当前动态配置。 */
  initialConfig?: DynamicConfigT;
  initialType?: DynamicTypeT;
  onDone: () => void;
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function defaultConfig(type: DynamicTypeT): DynamicConfigT {
  switch (type) {
    case 'date':
      return { type: 'date', tz: TZ, show_lunar: true, show_solar_term: true };
    case 'weather':
      return {
        type: 'weather',
        tz: TZ,
        provider: 'qweather',
        location_id: '101010100',
        location_label: '北京',
        units: 'metric',
      };
    case 'history_today':
      return { type: 'history_today', tz: TZ };
    case 'dashboard':
      return { type: 'dashboard', layout: 'metrics' };
  }
}

export function DynamicContentEditor({
  gid,
  content,
  initialConfig,
  initialType,
  onDone,
}: DynamicContentEditorProps) {
  const isEdit = !!content;
  const create = useCreateDynamicContent(gid);
  const update = useUpdateDynamicContent(gid);
  const updateAudio = useUpdateContentAudio(gid);
  const submitting = isEdit ? update.isPending || updateAudio.isPending : create.isPending;
  const toast = useToast();

  const [type, setType] = useState<DynamicTypeT | null>(initialType ?? null);
  const [caption, setCaption] = useState(content?.title ?? '');
  const [config, setConfig] = useState<DynamicConfigT | null>(initialConfig ?? null);
  const [audioFile, setAudioFile] = useState<File | null>(null);

  // type 变化时（create 模式选了一个）→ 重置 config 为默认
  useEffect(() => {
    if (!isEdit && type && (!config || config.type !== type)) {
      setConfig(defaultConfig(type));
    }
  }, [type, isEdit, config]);

  // 已保存的预览（edit 模式初始加载用）
  const savedPreviewEnabled = !!content?.content_id && !!content?.image_etag;
  const img = useContentImage(
    content?.content_id ?? '',
    savedPreviewEnabled ? content!.image_etag : ''
  );

  // 实时预览（创建/编辑模式均支持）
  const livePreviewEnabled = !!(type && config);
  const preview = usePreviewDynamicContent(content?.content_id);
  const [livePreviewData, setLivePreviewData] = useState<ArrayBuffer | null>(null);

  useEffect(() => {
    if (!livePreviewEnabled || !config) return;
    const parsed = DynamicConfig.safeParse(config);
    if (!parsed.success) return;
    const t = setTimeout(() => {
      preview.mutate(
        { config: parsed.data, title: caption.trim() || null },
        { onSuccess: (data) => setLivePreviewData(data) }
      );
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, caption, livePreviewEnabled]);

  async function onSubmit() {
    if (!type || !config) return;
    // 提交前用 shared 的 DynamicConfig zod 校验，避免后端 400 后才知道错。
    // 失败时把第一个 issue 反馈给用户。
    const parsed = DynamicConfig.safeParse(config);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join('.') || 'config';
      toast.error('配置有误', `${path}: ${first?.message ?? '请检查'}`);
      return;
    }
    try {
      if (isEdit) {
        await update.mutateAsync({
          contentId: content!.content_id,
          title: caption.trim() || null,
          config: parsed.data,
        });
        if (audioFile) {
          await updateAudio.mutateAsync({
            contentId: content!.content_id,
            audio: audioFile,
          });
        }
        toast.success('已保存');
      } else {
        const created = await create.mutateAsync({
          kind: 'dynamic',
          dynamic_type: type,
          config: parsed.data,
          title: caption.trim() || null,
        });
        if (audioFile) {
          await updateAudio.mutateAsync({
            contentId: created.content_id,
            audio: audioFile,
          });
        }
        toast.success('已创建');
      }
      onDone();
    } catch (err) {
      toast.error(isEdit ? '保存失败' : '创建失败', getApiErrorMessage(err));
    }
  }

  return (
    <div>
      <nav>
        <button
          onClick={onDone}
          className="inline-flex items-center gap-1.5 text-[11px] font-mono text-stone hover:text-ink tracking-[0.08em]"
        >
          <ArrowLeft size={14} /> 返回
        </button>
      </nav>

      <header className="mt-5 fade-up flex items-center gap-4">
        <IconBlock size="lg" tone="soft">
          <Sparkles size={24} />
        </IconBlock>
        <div className="flex-1 min-w-0">
          <h1 className="font-serif text-[32px] sm:text-[40px] font-bold leading-[1.2] truncate tracking-tight">
            {isEdit ? '编辑动态内容' : '新建动态内容'}
          </h1>
          <p className="font-sans text-[13px] text-stone mt-1.5 leading-relaxed">
            动态内容由服务端定时渲染下发，设备显示时会使用最新版本。
          </p>
        </div>
      </header>

      <DoubleRule className="mt-3" />

      <div className="mt-6 fade-up fade-up-1">
        <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-6 lg:gap-8">
          {/* 预览 */}
          <div className="order-2 lg:order-1">
            <p className="font-sans text-[12px] text-stone mb-2 ml-0.5">
              预览 · 1bpp · {FRAME_WIDTH}×{FRAME_HEIGHT}
            </p>
            <DynamicPreview
              img={img}
              savedPreviewEnabled={savedPreviewEnabled}
              liveData={livePreviewData}
              livePending={preview.isPending}
              hasConfig={!!config}
              caption={caption}
            />
            <p className="font-serif italic text-[11px] text-stone-light mt-2 text-center">
              {livePreviewEnabled
                ? preview.isPending
                  ? '渲染中…'
                  : livePreviewData
                    ? isEdit
                      ? '实时预览（未保存）'
                      : '实时预览'
                    : savedPreviewEnabled
                      ? '当前渲染快照'
                      : '修改参数后自动更新'
                : '选择动态类型后开始配置'}
            </p>
          </div>

          {/* 表单 */}
          <div className="order-1 lg:order-2 space-y-6">
            {!isEdit && (
              <div>
                <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-2">
                  类型
                </p>
                <DynamicTypePicker value={type} onChange={setType} disabled={isEdit} />
              </div>
            )}

            <Input
              label="标题（选填，最多 64 字）"
              type="text"
              maxLength={64}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="如：北京天气"
            />

            {config && (
              <DynamicConfigForm
                config={config}
                onChange={setConfig}
                contentId={content?.content_id}
              />
            )}

            <AudioDropzone
              gid={gid}
              hasExistingAudio={isEdit && !!content!.audio_etag}
              editingContentId={isEdit ? content!.content_id : null}
              audioFile={audioFile}
              onPick={setAudioFile}
            />

            {/* 操作按钮：粘在表单列底部，手机上全宽好点按 */}
            <div className="flex gap-3 pt-5 border-t border-line sticky bottom-0 bg-paper pb-4">
              <Button variant="outline" onClick={onDone} className="flex-1">
                取消
              </Button>
              <Button
                onClick={onSubmit}
                disabled={!type || !config || submitting}
                iconLeft={!submitting ? <ArrowUp size={16} /> : undefined}
                className="flex-1"
              >
                {submitting ? <Spinner /> : isEdit ? '保存' : '创建'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// 预览 canvas —— liveData 优先于 savedImg（实时预览覆盖上次保存的快照）。
function DynamicPreview({
  img,
  savedPreviewEnabled,
  liveData,
  livePending,
  hasConfig,
  caption,
}: {
  img: ReturnType<typeof useContentImage>;
  savedPreviewEnabled: boolean;
  liveData: ArrayBuffer | null;
  livePending: boolean;
  hasConfig: boolean;
  caption?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 画已保存的预览
  useEffect(() => {
    if (liveData || !img.data || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    const bytes = new Uint8Array(img.data);
    if (!isValidBppLength(bytes)) return;
    ctx.putImageData(decodeBppImage(bytes), 0, 0);
  }, [img.data, liveData]);

  // 画实时预览（覆盖已保存预览）
  useEffect(() => {
    if (!liveData || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    const bytes = new Uint8Array(liveData);
    if (!isValidBppLength(bytes)) return;
    ctx.putImageData(decodeBppImage(bytes), 0, 0);
  }, [liveData]);

  const showCanvas = savedPreviewEnabled || liveData;
  const showSpinner = livePending || (savedPreviewEnabled && img.isPending && !liveData);

  return (
    <div className="aspect-[4/3] bg-cream relative overflow-hidden border border-ink">
      {!showCanvas && !livePending ? (
        <div className="absolute inset-0 flex items-center justify-center text-stone-light text-[12px] font-sans">
          {hasConfig ? '保存后查看预览' : '↑ 选择动态类型'}
        </div>
      ) : showSpinner ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </div>
      ) : null}
      {/* canvas 始终挂载，只在有数据时才有内容 */}
      <canvas
        ref={canvasRef}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        className="block w-full h-full"
        style={{ display: showCanvas && !showSpinner ? 'block' : 'none' }}
      />
      <StatusBarOverlay caption={caption} />
    </div>
  );
}

// 按动态类型渲染不同的配置字段集合。
function DynamicConfigForm({
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
    case 'date':
      return (
        <div className="space-y-4">
          <Checkbox
            label="显示农历"
            checked={config.show_lunar}
            onChange={(v) => onChange({ ...config, show_lunar: v })}
          />
          <Checkbox
            label="显示节气（仅当日命中）"
            checked={config.show_solar_term}
            onChange={(v) => onChange({ ...config, show_solar_term: v })}
          />
        </div>
      );
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
  }
}

// 城市搜索：使用内嵌中国城市列表，选中后交给 QWeather 查询。
function CitySearch({
  value,
  onSelect,
}: {
  /** 当前已选城市名，受控值 */
  value: string;
  onSelect: (r: { locationId: string; label: string }) => void;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);

  // 外部受控值变化时同步（切换 type 重置等场景）
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
      `curl -X POST -H 'Content-Type: application/json' \\\n  -d '{"title":"销售","metrics":{"today":1234,"yesterday":1100}}' \\\n  ${url}`,
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
