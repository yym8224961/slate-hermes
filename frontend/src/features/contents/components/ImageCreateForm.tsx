import type { FormEvent, ReactNode } from 'react';
import { useToast } from '@/components/feedback/toast-context';
import { FormActions } from '@/components/ui/FormActions';
import { ImageFormBody } from '@/features/contents/components/image-form/ImageFormBody';
import { useGenerateContentTts } from '@/features/contents/query/content-audio-queries';
import { useCreateImageContent } from '@/features/contents/query/content-mutation-queries';
import { useImageContentForm } from '@/features/contents/hooks/useImageContentForm';
import { getApiErrorMessage } from '@/lib/api-errors';

interface ImageCreateFormProps {
  gid: string;
  header?: ReactNode;
  onDone: () => void;
  onEditCreatedImage?: (contentId: string) => void;
}

export function ImageCreateForm({ gid, header, onDone, onEditCreatedImage }: ImageCreateFormProps) {
  const createImage = useCreateImageContent(gid);
  const generateTts = useGenerateContentTts(gid);
  const toast = useToast();
  const form = useImageContentForm();
  const submitting = createImage.isPending || generateTts.isPending;

  async function submitContent() {
    if (!form.image.file) return;
    try {
      const fd = await form.buildFormData();
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
        beforeFields={header}
        actions={
          <FormActions
            onCancel={onDone}
            submitLabel="创建"
            disabled={!form.canCreate}
            submitting={submitting}
          />
        }
      />
    </form>
  );
}
