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
  DEFAULT_TTS_VOICE,
  isAudioDynamicConfig,
  type DynamicConfigT,
  type DitherMode,
  type TtsVoiceT,
} from 'shared';
import {
  useCreateImageContent,
  useCreateDynamicContent,
  useGenerateContentTts,
  usePreviewDynamicContent,
} from '@/features/contents/queries';
import { useToast } from '@/components/feedback/Toast';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { IconBlock } from '@/components/ui/IconBlock';
import { DoubleRule } from '@/components/ui/DoubleRule';
import { FormSection } from '@/components/ui/FormSection';
import { PreviewCanvas } from './image-editor/PreviewCanvas';
import { ImageDropzone } from './image-editor/ImageDropzone';
import { DitherControls } from './image-editor/DitherControls';
import { ImageAudioBlock, type ImageAudioMode } from './image-editor/ImageAudioBlock';
import { defaultConfig } from '@/features/dynamic-content/model/default-config';
import {
  DynamicConfigForm,
  DynamicAudioSection,
} from '@/features/dynamic-content/components/DynamicConfigForm';
import { getApiErrorMessage } from '@/lib/api-error';
import type { AllContentType } from './create/content-create-types';
import { ContentTypeCardGrid, ContentTypePicker } from './create/ContentTypePicker';
import { DynamicCreatePreview } from './create/DynamicCreatePreview';
import { defaultFrameName, effectiveFrameName, effectiveStatusBarText } from './create/frame-name';
import { TYPE_META, shouldRenderParams } from './create/type-meta';
import { useDynamicCreatePreview } from './create/useDynamicCreatePreview';

// ─── 主编辑器 ──────────────────────────────────────────────────────────────────

interface ContentCreateEditorProps {
  gid: string;
  onDone: () => void;
}

export function ContentCreateEditor({ gid, onDone }: ContentCreateEditorProps) {
  const createImage = useCreateImageContent(gid);
  const createDynamic = useCreateDynamicContent(gid);
  const generateTts = useGenerateContentTts(gid);
  const toast = useToast();

  // 通用
  const [type, setType] = useState<AllContentType | null>(null);
  const [frameName, setFrameName] = useState('');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [imageAudioMode, setImageAudioMode] = useState<ImageAudioMode>('upload');
  const [ttsText, setTtsText] = useState('');
  const [ttsVoice, setTtsVoice] = useState<TtsVoiceT>(DEFAULT_TTS_VOICE);

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

  const submitting = createImage.isPending || createDynamic.isPending || generateTts.isPending;
  const canSubmit =
    type === 'image'
      ? !!imageFile && (imageAudioMode !== 'tts' || ttsText.trim().length > 0)
      : !!(type && config);

  async function onSubmit() {
    if (!type) return;
    try {
      if (type === 'image') {
        if (!imageFile) return;
        const trimmedTtsText = ttsText.trim();
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
        if (imageAudioMode === 'upload' && audioFile) fd.append('audio', audioFile);
        fd.append('frame_name', frameName.trim());
        const created = await createImage.mutateAsync(fd);
        if (imageAudioMode === 'tts' && trimmedTtsText) {
          try {
            await generateTts.mutateAsync({
              contentId: created.id,
              body: { text: trimmedTtsText, voice: ttsVoice },
            });
          } catch (err) {
            toast.error('内容已新建，TTS 生成失败', getApiErrorMessage(err));
            onDone();
            return;
          }
        }
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
            <p className="font-mono text-[10px] leading-5 text-stone uppercase tracking-[0.18em] ml-0.5 mb-2">
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
          <div className="order-1 min-w-0 lg:order-2 lg:mt-7 space-y-6">
            {/* 类型块（chip + 描述 + 分隔线，内部 12px 等距）*/}
            <div className="space-y-3">
              {type ? (
                <ContentTypePicker
                  value={type}
                  onChange={handleTypeChange}
                  onBack={resetTypeSelection}
                />
              ) : (
                <ContentTypeCardGrid onChange={handleTypeChange} />
              )}
              {type && (
                <p className="font-sans text-[12px] text-stone leading-relaxed">
                  {TYPE_META[type].description}
                </p>
              )}
              {type && <div className="border-t border-line" />}
            </div>

            {type && (
              <>
                {/* 帧名称（仅 image / dashboard）*/}
                {(type === 'image' || type === 'dashboard') && (
                  <FormSection label="帧名称（选填，最多 64 字）">
                    <Input
                      type="text"
                      maxLength={64}
                      value={frameName}
                      onChange={(e) => setFrameName(e.target.value)}
                      placeholder={frameNamePlaceholder}
                    />
                  </FormSection>
                )}

                {/* 类型参数 */}
                {shouldRenderParams(type) && (
                  <FormSection label="类型参数">
                    {type === 'image' ? (
                      <div className="space-y-4">
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
                    ) : (
                      config && (
                        <DynamicConfigForm
                          config={config}
                          onChange={(next) => {
                            if (
                              next.type === 'weather' &&
                              config?.type === 'weather' &&
                              next.location_label !== config.location_label
                            ) {
                              setFrameName(defaultFrameName(next.type, next));
                            }
                            setConfig(next);
                          }}
                        />
                      )
                    )}
                  </FormSection>
                )}

                {/* 音频 */}
                {TYPE_META[type].supportsAudio && (
                  <FormSection label="音频">
                    {type === 'image' ? (
                      <ImageAudioBlock
                        gid={gid}
                        mode={imageAudioMode}
                        onModeChange={setImageAudioMode}
                        audioFile={audioFile}
                        onAudioFileChange={setAudioFile}
                        ttsText={ttsText}
                        onTtsTextChange={setTtsText}
                        ttsVoice={ttsVoice}
                        onTtsVoiceChange={setTtsVoice}
                        hasExistingAudio={false}
                        editingContentId={null}
                      />
                    ) : (
                      config &&
                      isAudioDynamicConfig(config) && (
                        <DynamicAudioSection config={config} onChange={setConfig} />
                      )
                    )}
                  </FormSection>
                )}

                {/* 操作按钮：粘在表单列底部 */}
                <div className="flex gap-3 pt-6 border-t border-line sticky bottom-0 bg-paper pb-6">
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
