// 图片内容编辑器 — 仅用于编辑已有图片内容；新建流程走 ContentCreateEditor。
//
// 拆分：
//   PreviewCanvas   — 1bpp 预览 + 拖拽/缩放交互
//   ImageDropzone   — 选图(可选)
//   AudioDropzone   — 选音频 + 删除已有音频
//   DitherControls  — 缩放 / 抖动算法 / 阈值

import { Image as ImageIcon } from 'lucide-react';
import type { ContentDetailT } from 'shared';
import {
  useContentImage,
  useGenerateContentTts,
  useUpdateImageContent,
} from '@/features/contents/queries';
import { useToast } from '@/components/feedback/Toast';
import { FormActions } from '@/components/ui/FormActions';
import { PageHeader } from '@/components/layout/PageHeader';
import { TYPE_META } from '@/features/contents/model/type-meta';
import { getApiErrorMessage } from '@/lib/api-errors';
import { useImageContentForm } from './useImageContentForm';
import { ImageFormBody } from './ImageFormBody';

interface ImageContentEditorProps {
  gid: string;
  content: ContentDetailT;
  onDone: () => void;
}

export function ImageContentEditor({ gid, content, onDone }: ImageContentEditorProps) {
  const updateImageContent = useUpdateImageContent(gid);
  const generateTts = useGenerateContentTts(gid);
  const submitting = updateImageContent.isPending || generateTts.isPending;
  const toast = useToast();
  const form = useImageContentForm(content);

  const existingImg = useContentImage(content.id, !form.imageFile ? content.image_etag : null);
  const canSubmit = form.canEdit;

  async function onSubmit() {
    try {
      const fd = await form.buildFormData();
      if (form.hasImagePatch) {
        await updateImageContent.mutateAsync({ contentId: content.id, form: fd });
      }
      if (form.wantsTts) {
        try {
          await generateTts.mutateAsync({
            contentId: content.id,
            body: { text: form.trimmedTtsText, voice: form.ttsVoice },
          });
        } catch (err) {
          const title = form.hasImagePatch ? '图片/名称已保存，TTS 生成失败' : 'TTS 生成失败';
          toast.error(title, getApiErrorMessage(err));
          if (form.hasImagePatch) onDone();
          return;
        }
      }
      toast.success('内容已保存');
      onDone();
    } catch (err) {
      toast.error('保存失败', getApiErrorMessage(err));
    }
  }

  return (
    <div>
      <PageHeader
        onBack={onDone}
        icon={<ImageIcon size={24} />}
        title={`编辑第 ${content.seq + 1} 项`}
        subtitle="改顺序请在组内用拖拽。"
      />

      <div className="mt-6 fade-up fade-up-1">
        <ImageFormBody
          gid={gid}
          form={form}
          isEdit
          existingImage={existingImg.data}
          existingImagePending={existingImg.isPending && !form.imageFile}
          hasExistingAudio={!!content.audio_etag}
          editingContentId={content.id}
          audioStatus={content.audio_status}
          audioError={content.audio_error}
          beforeFields={
            <div className="space-y-3">
              <p className="font-sans text-[12px] text-stone leading-relaxed">
                {TYPE_META.image.description}
              </p>
              <div className="border-t border-line" />
            </div>
          }
          actions={
            <FormActions
              onCancel={onDone}
              onSubmit={onSubmit}
              submitLabel="保存"
              disabled={!canSubmit}
              submitting={submitting}
            />
          }
        />
      </div>
    </div>
  );
}
