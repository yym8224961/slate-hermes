import type { FormEvent } from 'react';
import { useToast } from '@/components/feedback/Toast';
import { FormActions } from '@/components/ui/FormActions';
import { useGenerateContentTts } from '@/features/contents/query/content-audio-queries';
import { useCreateImageContent } from '@/features/contents/query/content-list-queries';
import { ImageFormBody } from '@/features/contents/components/image-editor/ImageFormBody';
import { useImageContentForm } from '@/features/contents/hooks/useImageContentForm';
import { TYPE_META, type AllContentType } from '@/features/contents/model/content-type-meta';
import { getApiErrorMessage } from '@/lib/api-errors';
import { ContentTypePicker } from './ContentTypePicker';

interface ImageCreateFormProps {
  gid: string;
  type: AllContentType;
  onTypeChange: (type: AllContentType) => void;
  onResetType: () => void;
  onDone: () => void;
  onEditCreatedImage?: (contentId: string) => void;
}

export function ImageCreateForm({
  gid,
  type,
  onTypeChange,
  onResetType,
  onDone,
  onEditCreatedImage,
}: ImageCreateFormProps) {
  const createImage = useCreateImageContent(gid);
  const generateTts = useGenerateContentTts(gid);
  const toast = useToast();
  const form = useImageContentForm();
  const submitting = createImage.isPending || generateTts.isPending;

  async function submitContent() {
    if (!form.image.file) return;
    try {
      const fd = await form.form.buildFormData();
      const created = await createImage.mutateAsync(fd);
      if (form.audio.wantsTts) {
        try {
          await generateTts.mutateAsync({
            contentId: created.id,
            body: { text: form.audio.trimmedTtsText, voice: form.audio.ttsVoice },
          });
        } catch (err) {
          toast.error('内容已新建，TTS 生成失败', getApiErrorMessage(err));
          if (onEditCreatedImage) onEditCreatedImage(created.id);
          else onDone();
          return;
        }
      }
      toast.success('内容已新建');
      onDone();
    } catch (err) {
      toast.error('创建失败', getApiErrorMessage(err));
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitContent();
  }

  return (
    <form onSubmit={onSubmit}>
      <ImageFormBody
        gid={gid}
        form={form}
        isEdit={false}
        gridClassName="lg:grid-cols-2"
        showSafeArea={Boolean(form.image.file)}
        beforeFields={
          <div className="space-y-3">
            <ContentTypePicker value={type} onChange={onTypeChange} onBack={onResetType} />
            <p className="font-sans text-[12px] text-stone leading-relaxed">
              {TYPE_META[type].description}
            </p>
            <div className="border-t border-line" />
          </div>
        }
        actions={
          <FormActions
            onCancel={onDone}
            submitLabel="创建"
            disabled={!form.form.canCreate}
            submitting={submitting}
          />
        }
      />
    </form>
  );
}
