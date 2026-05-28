import type { ReactNode } from 'react';
import { FRAME_HEIGHT, FRAME_WIDTH, type ContentDetailT } from 'shared';
import { Input } from '@/components/ui/Input';
import { FormSection } from '@/components/ui/FormSection';
import { cn } from '@/lib/cn';
import { DitherControls } from './DitherControls';
import { ImageAudioBlock } from './ImageAudioBlock';
import { ImageDropzone } from './ImageDropzone';
import { PreviewCanvas } from './PreviewCanvas';
import type { useImageContentForm } from './useImageContentForm';

interface ImageFormBodyProps {
  gid: string;
  form: ReturnType<typeof useImageContentForm>;
  isEdit: boolean;
  existingImage?: ArrayBuffer;
  existingImagePending?: boolean;
  hasExistingAudio?: boolean;
  editingContentId?: string | null;
  audioStatus?: ContentDetailT['audio_status'];
  audioError?: string | null;
  frameNamePlaceholder?: string;
  frameNameAutoFocus?: boolean;
  showSafeArea?: boolean;
  gridClassName?: string;
  beforeFields?: ReactNode;
  actions: ReactNode;
}

export function ImageFormBody({
  gid,
  form,
  isEdit,
  existingImage,
  existingImagePending,
  hasExistingAudio = false,
  editingContentId = null,
  audioStatus,
  audioError,
  frameNamePlaceholder = '如：挖掘机',
  frameNameAutoFocus,
  showSafeArea = true,
  gridClassName,
  beforeFields,
  actions,
}: ImageFormBodyProps) {
  return (
    <div
      className={cn('grid grid-cols-1 gap-6 lg:gap-8', gridClassName ?? 'lg:grid-cols-[1.3fr_1fr]')}
    >
      <div className="order-2 min-w-0 lg:order-1">
        <p className="font-mono text-[10px] leading-5 text-stone uppercase tracking-[0.18em] ml-0.5 mb-2">
          预览 · 1bpp · {FRAME_WIDTH}×{FRAME_HEIGHT}
        </p>
        <PreviewCanvas
          canvasRef={form.previewRef}
          imageFile={form.imageFile}
          existingImage={existingImage}
          existingImagePending={existingImagePending}
          threshold={form.threshold}
          mode={form.mode}
          scale={form.scale}
          offset={form.offset}
          onOffsetChange={form.setOffset}
          statusCaption={form.frameName.trim() || null}
          showSafeArea={showSafeArea}
        />
      </div>

      <div className="order-1 min-w-0 lg:order-2 lg:mt-7 space-y-6">
        {beforeFields}

        <FormSection label="帧名称（选填，最多 64 字）">
          <Input
            type="text"
            maxLength={64}
            value={form.frameName}
            onChange={(event) => form.setFrameName(event.target.value)}
            placeholder={frameNamePlaceholder}
            autoFocus={frameNameAutoFocus}
          />
        </FormSection>

        <FormSection label="类型参数" hint={isEdit ? '不传图片则保留原图。' : undefined}>
          <div className="space-y-4">
            <ImageDropzone isEdit={isEdit} imageFile={form.imageFile} onPick={form.onImagePick} />
            <DitherControls
              mode={form.mode}
              onModeChange={form.setMode}
              threshold={form.threshold}
              onThresholdChange={form.setThreshold}
              disabled={isEdit && !form.imageFile}
              hasImage={!!form.imageFile}
              scale={form.scale}
              onScaleChange={form.setScale}
              onResetCrop={form.resetCrop}
            />
          </div>
        </FormSection>

        <FormSection label="音频">
          <ImageAudioBlock
            gid={gid}
            mode={form.audioMode}
            onModeChange={form.setAudioMode}
            audioFile={form.audioFile}
            onAudioFileChange={form.setAudioFile}
            ttsText={form.ttsText}
            onTtsTextChange={form.setTtsText}
            ttsVoice={form.ttsVoice}
            onTtsVoiceChange={form.setTtsVoice}
            hasExistingAudio={hasExistingAudio}
            editingContentId={editingContentId}
            audioStatus={audioStatus}
            audioError={audioError}
          />
        </FormSection>

        {actions}
      </div>
    </div>
  );
}
