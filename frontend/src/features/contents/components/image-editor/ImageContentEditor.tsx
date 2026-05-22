// 图片内容编辑器 — create + edit 共用同一套 form，作为独立页面渲染。
//
// 拆分：
//   PreviewCanvas   — 1bpp 预览 + 拖拽/缩放交互
//   ImageDropzone   — 选图(可选)
//   AudioDropzone   — 选音频 + 删除已有音频
//   DitherControls  — 缩放 / 抖动算法 / 阈值

import { useState, useRef } from 'react';
import { ArrowLeft, ArrowUp, Image as ImageIcon } from 'lucide-react';
import {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  BW_THRESHOLD_DEFAULT,
  DEFAULT_DITHER_MODE,
  DEFAULT_TTS_VOICE,
} from 'shared';
import type { ContentDetailT, DitherMode, TtsVoiceT } from 'shared';
import {
  useContentImage,
  useCreateImageContent,
  useGenerateContentTts,
  useUpdateImageContent,
} from '@/features/contents/queries';
import { useToast } from '@/components/feedback/Toast';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { IconBlock } from '@/components/ui/IconBlock';
import { DoubleRule } from '@/components/ui/DoubleRule';
import { FormSection } from '@/components/ui/FormSection';
import { PreviewCanvas } from './PreviewCanvas';
import { ImageDropzone } from './ImageDropzone';
import { DitherControls } from './DitherControls';
import { ImageAudioBlock, type ImageAudioMode } from './ImageAudioBlock';
import { TYPE_META } from '../create/type-meta';
import { getApiErrorMessage } from '@/lib/api-error';

interface ImageContentEditorProps {
  gid: string;
  /** edit 模式传现有 content；create 模式不传 */
  content?: ContentDetailT;
  onDone: () => void;
}

export function ImageContentEditor({ gid, content, onDone }: ImageContentEditorProps) {
  const isEdit = !!content;
  const createImageContent = useCreateImageContent(gid);
  const updateImageContent = useUpdateImageContent(gid);
  const generateTts = useGenerateContentTts(gid);
  const submitting = isEdit
    ? updateImageContent.isPending || generateTts.isPending
    : createImageContent.isPending || generateTts.isPending;
  const toast = useToast();

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioMode, setAudioMode] = useState<ImageAudioMode>(
    isEdit && content.audio_source === 'tts' ? 'tts' : 'upload'
  );
  const [ttsText, setTtsText] = useState(isEdit ? (content.audio_text ?? '') : '');
  const [ttsVoice, setTtsVoice] = useState<TtsVoiceT>(
    isEdit && content.audio_voice ? content.audio_voice : DEFAULT_TTS_VOICE
  );
  const [threshold, setThreshold] = useState(BW_THRESHOLD_DEFAULT);
  const [mode, setMode] = useState<DitherMode>(DEFAULT_DITHER_MODE);
  const [frameName, setFrameName] = useState(isEdit ? (content.frame_name ?? '') : '');
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const previewRef = useRef<HTMLCanvasElement>(null);

  const existingImg = useContentImage(
    content?.id ?? '',
    isEdit && !imageFile ? (content?.image_etag ?? '') : ''
  );

  const frameNameChanged = isEdit && frameName !== (content.frame_name ?? '');
  const trimmedTtsText = ttsText.trim();
  const existingTtsText = content?.audio_text?.trim() ?? '';
  const hasExistingTts = isEdit && content?.audio_source === 'tts';
  const wantsTts =
    audioMode === 'tts' &&
    trimmedTtsText.length > 0 &&
    (!hasExistingTts ||
      content?.audio_status === 'failed' ||
      trimmedTtsText !== existingTtsText ||
      ttsVoice !== content?.audio_voice);
  const canSubmit = isEdit
    ? (!!imageFile || !!audioFile || frameNameChanged || wantsTts) &&
      (audioMode !== 'tts' || trimmedTtsText.length > 0)
    : !!imageFile && (audioMode !== 'tts' || trimmedTtsText.length > 0);

  function resetCrop() {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  function onImagePick(f: File | null) {
    setImageFile(f);
    resetCrop();
  }

  async function onSubmit() {
    const fd = new FormData();
    if (imageFile) {
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
    }
    if (audioFile) fd.append('audio', audioFile);
    fd.append('frame_name', frameName.trim());

    try {
      let targetContentId = content?.id ?? null;
      const hasImagePatch = !!imageFile || !!audioFile || frameNameChanged;
      if (isEdit) {
        if (!content) return;
        if (hasImagePatch) {
          await updateImageContent.mutateAsync({ contentId: content.id, form: fd });
        }
        targetContentId = content.id;
        toast.success('内容已保存');
      } else {
        const created = await createImageContent.mutateAsync(fd);
        targetContentId = created.id;
        toast.success('内容已新建');
      }
      if (wantsTts && targetContentId) {
        try {
          await generateTts.mutateAsync({
            contentId: targetContentId,
            body: { text: trimmedTtsText, voice: ttsVoice },
          });
        } catch (err) {
          toast.error('内容已保存，TTS 生成失败', getApiErrorMessage(err));
          onDone();
          return;
        }
      }
      onDone();
    } catch (err) {
      toast.error(isEdit ? '保存失败' : '新建失败', getApiErrorMessage(err));
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
          <ImageIcon size={24} />
        </IconBlock>
        <div className="flex-1 min-w-0">
          <h1 className="font-serif text-[32px] sm:text-[40px] font-bold leading-[1.2] truncate tracking-tight">
            {isEdit && content ? `编辑第 ${content.seq + 1} 项` : '新建图片内容'}
          </h1>
          <p className="font-sans text-[13px] text-stone mt-1.5 leading-relaxed">
            {isEdit ? '改顺序请在组内用拖拽。' : '追加至列表末尾，可拖拽改序。'}
          </p>
        </div>
      </header>

      <DoubleRule className="mt-3" />

      <div className="mt-6 fade-up fade-up-1">
        <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-6 lg:gap-8">
          {/* 预览(desktop 左 / mobile 排在控件下) */}
          <div className="order-2 lg:order-1">
            <div>
              <p className="font-mono text-[10px] leading-5 text-stone uppercase tracking-[0.18em] ml-0.5 mb-2">
                预览 · 1bpp · {FRAME_WIDTH}×{FRAME_HEIGHT}
              </p>
              <PreviewCanvas
                canvasRef={previewRef}
                imageFile={imageFile}
                existingImage={isEdit ? existingImg.data : undefined}
                existingImagePending={isEdit && existingImg.isPending && !imageFile}
                threshold={threshold}
                mode={mode}
                scale={scale}
                offset={offset}
                onOffsetChange={setOffset}
                statusCaption={frameName.trim() || null}
                showSafeArea
              />
            </div>
          </div>

          {/* 控件 */}
          <div className="order-1 lg:order-2 lg:mt-7 space-y-6">
            {/* 编辑模式类型描述块（描述 + 分隔线，间距 12px）*/}
            {isEdit && (
              <div className="space-y-3">
                <p className="font-sans text-[12px] text-stone leading-relaxed">
                  {TYPE_META.image.description}
                </p>
                <div className="border-t border-line" />
              </div>
            )}

            {/* 帧名称 */}
            <FormSection label="帧名称（选填，最多 64 字）">
              <Input
                type="text"
                maxLength={64}
                value={frameName}
                onChange={(e) => setFrameName(e.target.value)}
                placeholder="如：挖掘机"
                autoFocus={!isEdit}
              />
            </FormSection>

            {/* 类型参数（图片本体） */}
            <FormSection label="类型参数" hint={isEdit ? '不传图片则保留原图。' : undefined}>
              <div className="space-y-4">
                <ImageDropzone isEdit={isEdit} imageFile={imageFile} onPick={onImagePick} />
                <DitherControls
                  mode={mode}
                  onModeChange={setMode}
                  threshold={threshold}
                  onThresholdChange={setThreshold}
                  hasImage={!!imageFile}
                  scale={scale}
                  onScaleChange={setScale}
                  onResetCrop={resetCrop}
                />
              </div>
            </FormSection>

            {/* 音频 */}
            <FormSection label="音频">
              <ImageAudioBlock
                gid={gid}
                mode={audioMode}
                onModeChange={setAudioMode}
                audioFile={audioFile}
                onAudioFileChange={setAudioFile}
                ttsText={ttsText}
                onTtsTextChange={setTtsText}
                ttsVoice={ttsVoice}
                onTtsVoiceChange={setTtsVoice}
                hasExistingAudio={isEdit && !!content?.audio_etag}
                editingContentId={isEdit ? (content?.id ?? null) : null}
                audioStatus={content?.audio_status}
                audioError={content?.audio_error}
              />
            </FormSection>

            {/* 操作按钮 */}
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
                {submitting ? <Spinner /> : isEdit ? '保存' : '上传'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
