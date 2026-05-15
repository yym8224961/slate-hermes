// 统一新建编辑器 — 图片 + 所有动态类型在同一页面切换。
// 仅用于新建；编辑流程仍使用各自的 ImageContentEditor / DynamicContentEditor。

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUp,
  Image as ImageIcon,
  Calendar,
  CloudSun,
  BookText,
  BarChart3,
  Plus,
} from 'lucide-react';
import {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  BW_THRESHOLD_DEFAULT,
  DEFAULT_DITHER_MODE,
  DynamicConfig,
  type DynamicConfigT,
  type DynamicTypeT,
  type DitherMode,
} from 'shared';
import {
  useCreateImageContent,
  useCreateDynamicContent,
  usePreviewDynamicContent,
  useUpdateContentAudio,
} from '../lib/queries';
import { useToast } from './Toast';
import { Input } from './Input';
import { Button } from './Button';
import { Spinner } from './Spinner';
import { IconBlock } from './IconBlock';
import { DoubleRule } from './DoubleRule';
import { PreviewCanvas } from './image-content-editor-controls/PreviewCanvas';
import { ImageDropzone } from './image-content-editor-controls/ImageDropzone';
import { DitherControls } from './image-content-editor-controls/DitherControls';
import { AudioDropzone } from './image-content-editor-controls/AudioDropzone';
import { StatusBarOverlay } from './StatusBarOverlay';
import { defaultConfig } from './dynamicDefaultConfig';
import { DynamicConfigForm } from './DynamicConfigForm';
import { decodeBppImage, isValidBppLength } from '../lib/image';
import { getApiErrorMessage } from '../lib/api-error';
import { cn } from '../lib/cn';

// ─── 类型注册表 ────────────────────────────────────────────────────────────────
// 新增动态类型：在 shared/src/types/dynamic.ts 加枚举值后，在此加一行即可。

type AllContentType = 'image' | DynamicTypeT;

const TYPE_ITEMS: Array<{
  type: AllContentType;
  title: string;
  hint: string;
  Icon: typeof ImageIcon;
}> = [
  { type: 'image', title: '图片', hint: '上传图片，自动转 1bpp', Icon: ImageIcon },
  { type: 'date', title: '日期', hint: '公历 · 星期 · 农历 · 节气', Icon: Calendar },
  { type: 'weather', title: '天气', hint: '实时气温 / 湿度 / 风速', Icon: CloudSun },
  {
    type: 'history_today',
    title: '历史上的今天',
    hint: '今日历史大事，每日 0 点更新',
    Icon: BookText,
  },
  { type: 'dashboard', title: '数据看板', hint: '外部 POST 数据，立即刷新', Icon: BarChart3 },
];

// ─── 类型选择网格 ───────────────────────────────────────────────────────────────

function ContentTypePicker({
  value,
  onChange,
}: {
  value: AllContentType | null;
  onChange: (t: AllContentType) => void;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {TYPE_ITEMS.map((it) => {
        const selected = value === it.type;
        return (
          <button
            key={it.type}
            type="button"
            onClick={() => onChange(it.type)}
            className={cn(
              'craft-card flex flex-col items-start gap-2 p-4 text-left transition-all',
              selected ? 'bg-ink text-paper border-ink' : 'hover:bg-cream'
            )}
          >
            <it.Icon size={22} />
            <span className="font-serif text-[18px] leading-none">{it.title}</span>
            <span
              className={cn(
                'font-sans text-[12px] leading-snug',
                selected ? 'text-paper/70' : 'text-stone'
              )}
            >
              {it.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── 动态类型实时预览 canvas（仅 create 模式，无已保存快照）────────────────────

function DynamicCreatePreview({
  liveData,
  livePending,
  hasConfig,
  caption,
}: {
  liveData: ArrayBuffer | null;
  livePending: boolean;
  hasConfig: boolean;
  caption: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!liveData || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    const bytes = new Uint8Array(liveData);
    if (!isValidBppLength(bytes)) return;
    ctx.putImageData(decodeBppImage(bytes), 0, 0);
  }, [liveData]);

  const showCanvas = !!liveData && !livePending;

  return (
    <div className="bg-paper border border-ink relative overflow-hidden aspect-[4/3]">
      {!liveData && !livePending && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="font-serif italic text-[13px] text-stone-light">
            {hasConfig ? '修改参数后自动更新' : '选择类型后开始配置'}
          </span>
        </div>
      )}
      {livePending && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        className="block w-full h-full"
        style={{ display: showCanvas ? 'block' : 'none' }}
      />
      <StatusBarOverlay caption={caption} />
    </div>
  );
}

// ─── 主编辑器 ──────────────────────────────────────────────────────────────────

interface ContentCreateEditorProps {
  gid: string;
  onDone: () => void;
}

export function ContentCreateEditor({ gid, onDone }: ContentCreateEditorProps) {
  const createImage = useCreateImageContent(gid);
  const createDynamic = useCreateDynamicContent(gid);
  const updateAudio = useUpdateContentAudio(gid);
  const toast = useToast();

  // 通用
  const [type, setType] = useState<AllContentType | null>(null);
  const [caption, setCaption] = useState('');
  const [audioFile, setAudioFile] = useState<File | null>(null);

  // 图片专属
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [threshold, setThreshold] = useState(BW_THRESHOLD_DEFAULT);
  const [mode, setMode] = useState<DitherMode>(DEFAULT_DITHER_MODE);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const previewRef = useRef<HTMLCanvasElement>(null);

  // 动态类型专属
  const [config, setConfig] = useState<DynamicConfigT | null>(null);
  const preview = usePreviewDynamicContent(undefined);
  const [livePreviewData, setLivePreviewData] = useState<ArrayBuffer | null>(null);

  // 切换类型时重置类型相关状态，公共状态（标题、音频）保留
  function handleTypeChange(t: AllContentType) {
    if (t === type) return;
    setType(t);
    if (t === 'image') {
      setConfig(null);
      setLivePreviewData(null);
    } else {
      setImageFile(null);
      setScale(1);
      setOffset({ x: 0, y: 0 });
      setConfig(defaultConfig(t));
      setLivePreviewData(null);
    }
  }

  // 动态类型：config / caption 变化时触发实时预览（800ms 防抖）
  useEffect(() => {
    if (!config || type === 'image' || type === null) return;
    const parsed = DynamicConfig.safeParse(config);
    if (!parsed.success) return;
    const timer = setTimeout(() => {
      preview.mutate(
        { config: parsed.data, title: caption.trim() || null },
        { onSuccess: (data) => setLivePreviewData(data) }
      );
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, caption]);

  const submitting = createImage.isPending || createDynamic.isPending || updateAudio.isPending;
  const canSubmit = type === 'image' ? !!imageFile : !!(type && config);

  async function onSubmit() {
    if (!type) return;
    try {
      if (type === 'image') {
        if (!imageFile) return;
        const fd = new FormData();
        const canvas = previewRef.current;
        if (canvas) {
          const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (b) => (b ? resolve(b) : reject(new Error('canvas export failed'))),
              'image/png'
            );
          });
          fd.append('image', blob, 'cropped.png');
        }
        fd.append('threshold', String(threshold));
        fd.append('mode', mode);
        if (audioFile) fd.append('audio', audioFile);
        fd.append('title', caption.trim());
        await createImage.mutateAsync(fd);
        toast.success('内容已新建');
      } else {
        if (!config) return;
        const parsed = DynamicConfig.safeParse(config);
        if (!parsed.success) {
          const first = parsed.error.issues[0];
          toast.error(
            '配置有误',
            `${first?.path.join('.') || 'config'}: ${first?.message ?? '请检查'}`
          );
          return;
        }
        const created = await createDynamic.mutateAsync({
          kind: 'dynamic',
          dynamic_type: type,
          config: parsed.data,
          title: caption.trim() || null,
        });
        if (audioFile) {
          await updateAudio.mutateAsync({ contentId: created.content_id, audio: audioFile });
        }
        toast.success('已创建');
      }
      onDone();
    } catch (err) {
      toast.error('创建失败', getApiErrorMessage(err));
    }
  }

  const captionPlaceholder =
    type === 'image' ? '如：挖掘机' : type === 'weather' ? '如：北京天气' : '';

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
          <Plus size={24} />
        </IconBlock>
        <div className="flex-1 min-w-0">
          <h1 className="font-serif text-[32px] sm:text-[40px] font-bold leading-[1.2] truncate tracking-tight">
            新建帧
          </h1>
          <p className="font-sans text-[13px] text-stone mt-1.5 leading-relaxed">
            选择类型后填写参数，创建后追加至列表末尾，可拖拽改序。
          </p>
        </div>
      </header>

      <DoubleRule className="mt-3" />

      <div className="mt-6 fade-up fade-up-1">
        <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-6 lg:gap-8">
          {/* 预览（desktop 左侧 / mobile 排在控件下方）*/}
          <div className="order-2 lg:order-1">
            <p className="font-sans text-[12px] text-stone mb-2 ml-0.5">
              预览 · 1bpp · {FRAME_WIDTH}×{FRAME_HEIGHT}
            </p>
            {type === 'image' ? (
              <PreviewCanvas
                canvasRef={previewRef}
                imageFile={imageFile}
                existingImage={undefined}
                threshold={threshold}
                mode={mode}
                caption={caption}
                showSafeArea={false}
                scale={scale}
                offset={offset}
                onOffsetChange={setOffset}
              />
            ) : (
              <DynamicCreatePreview
                liveData={livePreviewData}
                livePending={preview.isPending}
                hasConfig={!!config}
                caption={caption}
              />
            )}
          </div>

          {/* 表单 */}
          <div className="order-1 lg:order-2 space-y-6">
            {/* 类型选择 */}
            <div>
              <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-2">
                类型
              </p>
              <ContentTypePicker value={type} onChange={handleTypeChange} />
            </div>

            {type && (
              <>
                <Input
                  label="标题（选填，最多 64 字）"
                  type="text"
                  maxLength={64}
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  placeholder={captionPlaceholder}
                />

                {/* 图片控件 */}
                {type === 'image' && (
                  <div className="space-y-4">
                    <p className="font-sans text-[12px] text-stone ml-0.5">图片</p>
                    <ImageDropzone
                      isEdit={false}
                      imageFile={imageFile}
                      onPick={(f) => {
                        setImageFile(f);
                        setScale(1);
                        setOffset({ x: 0, y: 0 });
                      }}
                    />
                    <DitherControls
                      mode={mode}
                      onModeChange={setMode}
                      threshold={threshold}
                      onThresholdChange={setThreshold}
                      hasImage={!!imageFile}
                      scale={scale}
                      onScaleChange={setScale}
                      onResetCrop={() => {
                        setScale(1);
                        setOffset({ x: 0, y: 0 });
                      }}
                    />
                  </div>
                )}

                {/* 动态配置表单 */}
                {config && type !== 'image' && (
                  <DynamicConfigForm config={config} onChange={setConfig} />
                )}

                <AudioDropzone
                  gid={gid}
                  hasExistingAudio={false}
                  editingContentId={null}
                  audioFile={audioFile}
                  onPick={setAudioFile}
                />

                <div className="flex gap-3 pt-5 border-t border-line sticky bottom-0 bg-paper pb-4">
                  <Button variant="outline" onClick={onDone} className="flex-1">
                    取消
                  </Button>
                  <Button
                    onClick={onSubmit}
                    disabled={!canSubmit || submitting}
                    iconLeft={!submitting ? <ArrowUp size={16} /> : undefined}
                    className="flex-1"
                  >
                    {submitting ? <Spinner /> : '创建'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
