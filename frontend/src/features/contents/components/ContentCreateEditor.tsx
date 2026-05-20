// 统一新建编辑器 — 图片 + 所有动态类型在同一页面切换。
// 仅用于新建；编辑流程仍使用各自的 ImageContentEditor / DynamicContentEditor。

import { useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Plus } from 'lucide-react';
import {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  BW_THRESHOLD_DEFAULT,
  DEFAULT_DITHER_MODE,
  DynamicConfig,
  type DynamicConfigT,
  type DitherMode,
} from 'shared';
import {
  useCreateImageContent,
  useCreateDynamicContent,
  usePreviewDynamicContent,
} from '@/features/contents/queries';
import { useToast } from '@/components/feedback/Toast';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { IconBlock } from '@/components/ui/IconBlock';
import { DoubleRule } from '@/components/ui/DoubleRule';
import { PreviewCanvas } from './image-editor/PreviewCanvas';
import { ImageDropzone } from './image-editor/ImageDropzone';
import { DitherControls } from './image-editor/DitherControls';
import { AudioDropzone } from './image-editor/AudioDropzone';
import { defaultConfig } from '@/features/dynamic-content/model/default-config';
import { DynamicConfigForm } from '@/features/dynamic-content/components/DynamicConfigForm';
import { getApiErrorMessage } from '@/lib/api-error';
import { cn } from '@/lib/cn';
import type { AllContentType } from './create/content-create-types';
import { ContentTypeCardGrid, ContentTypePicker } from './create/ContentTypePicker';
import { DynamicCreatePreview } from './create/DynamicCreatePreview';
import {
  defaultFrameName,
  effectiveFrameName,
  effectiveStatusBarText,
  hasVisibleDynamicConfig,
} from './create/frame-name';
import { useDynamicCreatePreview } from './create/useDynamicCreatePreview';

// ─── 主编辑器 ──────────────────────────────────────────────────────────────────

interface ContentCreateEditorProps {
  gid: string;
  onDone: () => void;
}

export function ContentCreateEditor({ gid, onDone }: ContentCreateEditorProps) {
  const createImage = useCreateImageContent(gid);
  const createDynamic = useCreateDynamicContent(gid);
  const toast = useToast();

  // 通用
  const [type, setType] = useState<AllContentType | null>(null);
  const [frameName, setFrameName] = useState('');
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
  const { livePreviewData, invalidatePreview } = useDynamicCreatePreview({
    type,
    config,
    frameName,
    preview,
  });

  function handleTypeChange(t: AllContentType) {
    if (t === type) return;
    invalidatePreview();
    setType(t);
    if (t === 'image') {
      setFrameName('');
      setConfig(null);
    } else {
      const nextConfig = defaultConfig(t);
      setFrameName(defaultFrameName(t, nextConfig));
      setAudioFile(null);
      setImageFile(null);
      setScale(1);
      setOffset({ x: 0, y: 0 });
      setConfig(nextConfig);
    }
  }

  function resetTypeSelection() {
    invalidatePreview();
    setType(null);
    setFrameName('');
    setAudioFile(null);
    setImageFile(null);
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setConfig(null);
  }

  const submitting = createImage.isPending || createDynamic.isPending;
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
        fd.append('frame_name', frameName.trim());
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
        await createDynamic.mutateAsync({
          kind: 'dynamic',
          config: parsed.data,
          frame_name: effectiveFrameName(type, parsed.data, frameName),
        });
        toast.success('已创建');
      }
      onDone();
    } catch (err) {
      toast.error('创建失败', getApiErrorMessage(err));
    }
  }

  const frameNamePlaceholder =
    type === 'image' ? '如：挖掘机' : type === 'weather' ? '如：北京天气' : '';
  const sectionLabelCls =
    'h-5 font-mono text-[10px] leading-5 text-stone uppercase tracking-[0.18em] mb-2';

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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
          {/* 预览（desktop 左侧 / mobile 排在控件下方）*/}
          <div className="order-2 min-w-0 lg:order-1">
            <p className={cn(sectionLabelCls, 'ml-0.5')}>
              {type === 'image' ? `预览 · 1bpp · ${FRAME_WIDTH}×${FRAME_HEIGHT}` : '设备预览'}
            </p>
            {type === 'image' ? (
              <PreviewCanvas
                canvasRef={previewRef}
                imageFile={imageFile}
                existingImage={undefined}
                threshold={threshold}
                mode={mode}
                scale={scale}
                offset={offset}
                onOffsetChange={setOffset}
                statusCaption={frameName.trim() || null}
                showSafeArea={Boolean(imageFile)}
              />
            ) : (
              <DynamicCreatePreview
                liveData={livePreviewData}
                livePending={preview.isPending}
                hasConfig={!!config}
                caption={effectiveStatusBarText(type, config, frameName)}
              />
            )}
          </div>

          {/* 表单 */}
          <div className="order-1 min-w-0 lg:order-2 space-y-5">
            {/* 类型选择 */}
            <div>
              <p className={sectionLabelCls}>类型</p>
              {type ? (
                <ContentTypePicker
                  value={type}
                  onChange={handleTypeChange}
                  onBack={resetTypeSelection}
                />
              ) : (
                <ContentTypeCardGrid onChange={handleTypeChange} />
              )}
            </div>

            {type && (
              <>
                {(type === 'image' || type === 'dashboard') && (
                  <Input
                    label="帧名称（选填，最多 64 字）"
                    type="text"
                    maxLength={64}
                    value={frameName}
                    onChange={(e) => setFrameName(e.target.value)}
                    placeholder={frameNamePlaceholder}
                  />
                )}

                {/* 图片控件 */}
                {type === 'image' && (
                  <div className="space-y-4">
                    <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em]">
                      图片参数
                    </p>
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
                {config && type !== 'image' && hasVisibleDynamicConfig(config) && (
                  <div className="space-y-4">
                    <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em]">
                      类型参数
                    </p>
                    <DynamicConfigForm
                      config={config}
                      onChange={(next) => {
                        setConfig(next);
                        if (next.type === 'weather')
                          setFrameName(defaultFrameName(next.type, next));
                      }}
                    />
                  </div>
                )}

                {type === 'image' && (
                  <AudioDropzone
                    gid={gid}
                    hasExistingAudio={false}
                    editingContentId={null}
                    audioFile={audioFile}
                    onPick={setAudioFile}
                  />
                )}

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
