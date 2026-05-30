// 统一新建编辑器 — 图片 + 所有动态类型在同一页面切换。
// 仅用于新建；编辑流程仍使用各自的 ImageContentEditor / DynamicContentEditor。

import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { DASHBOARD_CUSTOM_STARTER_TEST_DATA } from 'shared/dynamic/test-fixtures';
import {
  useCreateImageContent,
  useCreateDynamicContent,
  useGenerateContentTts,
} from '@/features/contents/queries';
import { useToast } from '@/components/feedback/useToast';
import { FormActions } from '@/components/ui/FormActions';
import { PageHeader } from '@/components/layout/PageHeader';
import { useImageContentForm } from '@/features/contents/hooks/useImageContentForm';
import { ImageFormBody } from '@/features/contents/components/image-editor/ImageFormBody';
import { getApiErrorMessage } from '@/lib/api-errors';
import { ContentTypeCardGrid, ContentTypePicker } from './ContentTypePicker';
import { DynamicFramePreview } from '@/features/dynamic/components/preview/DynamicPreview';
import { TYPE_META, type AllContentType } from '@/features/contents/model/type-meta';
import { DynamicContentFormShell } from '@/features/dynamic/components/DynamicContentFormShell';
import { useDynamicContentForm } from '@/features/dynamic/hooks/useDynamicContentForm';

// ─── 主编辑器 ──────────────────────────────────────────────────────────────────

interface ContentCreateEditorProps {
  gid: string;
  onDone: () => void;
  onEditCreatedImage?: (contentId: string) => void;
}

export function ContentCreateEditor({ gid, onDone, onEditCreatedImage }: ContentCreateEditorProps) {
  const createImage = useCreateImageContent(gid);
  const createDynamic = useCreateDynamicContent(gid);
  const generateTts = useGenerateContentTts(gid);
  const toast = useToast();
  const imageForm = useImageContentForm();
  const dynamicForm = useDynamicContentForm({ requireDashboardData: true });

  // 通用
  const [type, setType] = useState<AllContentType | null>(null);
  const dynamicType = type && type !== 'image' ? type : null;

  function handleTypeChange(t: AllContentType) {
    if (t === type) return;
    setType(t);
    if (t === 'image') {
      dynamicForm.reset();
    } else {
      imageForm.form.reset();
      dynamicForm.loadType(t, t === 'dashboard' ? { ...DASHBOARD_CUSTOM_STARTER_TEST_DATA } : null);
    }
  }

  function resetTypeSelection() {
    setType(null);
    imageForm.form.reset();
    dynamicForm.reset();
  }

  const submitting = createImage.isPending || createDynamic.isPending || generateTts.isPending;
  const canSubmit = type === 'image' ? imageForm.form.canCreate : dynamicForm.canSubmit;

  async function submitContent() {
    if (!type) return;
    try {
      if (type === 'image') {
        if (!imageForm.image.file) return;
        const fd = await imageForm.form.buildFormData();
        const created = await createImage.mutateAsync(fd);
        if (imageForm.audio.wantsTts) {
          try {
            await generateTts.mutateAsync({
              contentId: created.id,
              body: { text: imageForm.audio.trimmedTtsText, voice: imageForm.audio.ttsVoice },
            });
          } catch (err) {
            toast.error('内容已新建，TTS 生成失败', getApiErrorMessage(err));
            if (onEditCreatedImage) onEditCreatedImage(created.id);
            else onDone();
            return;
          }
        }
        toast.success('内容已新建');
      } else {
        const parsed = dynamicForm.submitConfig();
        if (!parsed.ok) {
          toast.error('配置有误', parsed.error);
          return;
        }
        await createDynamic.mutateAsync({
          kind: 'dynamic',
          config: parsed.config,
          frame_name: parsed.frameName,
          initial_data: parsed.dashboardData,
        });
        toast.success('已创建');
      }
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
    <div>
      <PageHeader
        onBack={onDone}
        icon={<Plus size={24} />}
        title="新建帧"
        subtitle="选择类型后填写参数，创建后追加至列表末尾，可拖拽改序。"
      />

      <div className="mt-6 fade-up fade-up-1">
        {type === 'image' ? (
          <form onSubmit={onSubmit}>
            <ImageFormBody
              gid={gid}
              form={imageForm}
              isEdit={false}
              gridClassName="lg:grid-cols-2"
              showSafeArea={Boolean(imageForm.image.file)}
              beforeFields={
                <div className="space-y-3">
                  <ContentTypePicker
                    value={type}
                    onChange={handleTypeChange}
                    onBack={resetTypeSelection}
                  />
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
                  disabled={!canSubmit}
                  submitting={submitting}
                />
              }
            />
          </form>
        ) : (
          <DynamicContentFormShell
            type={dynamicType}
            config={dynamicForm.config}
            frameName={dynamicForm.frameName}
            onFrameNameChange={dynamicForm.setFrameName}
            onConfigChange={dynamicForm.changeConfig}
            onSubmit={onSubmit}
            dashboardData={dynamicForm.dashboardData}
            onDashboardDataChange={dynamicForm.setDashboardData}
            dashboardDataLabel="初始数据 JSON"
            gridClassName="lg:grid-cols-2"
            preview={
              <DynamicFramePreview
                data={dynamicForm.livePreviewData}
                pending={dynamicForm.preview.isPending}
                hasConfig={!!dynamicForm.config}
                caption={dynamicForm.caption}
              />
            }
            header={
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
            }
            actions={
              <FormActions
                onCancel={onDone}
                submitLabel="创建"
                disabled={!canSubmit}
                submitting={submitting}
              />
            }
          />
        )}
      </div>
    </div>
  );
}
