import type { FormEvent } from 'react';
import { isAudioDynamicConfig } from 'shared';
import { useToast } from '@/components/feedback/Toast';
import { FormActions } from '@/components/ui/FormActions';
import { useCreateDynamicContent } from '@/features/contents/query/content-dynamic-queries';
import { TYPE_META, type AllContentType } from '@/features/contents/model/content-type-meta';
import { DynamicContentFields } from '@/features/dynamic/components/DynamicContentFields';
import { DynamicContentFormShell } from '@/features/dynamic/components/DynamicContentFormShell';
import { DynamicFramePreview } from '@/features/dynamic/components/DynamicFramePreview';
import { useDynamicContentForm } from '@/features/dynamic/hooks/useDynamicContentForm';
import { DYNAMIC_TYPE_META } from '@/features/dynamic/model/type-meta';
import { getApiErrorMessage } from '@/lib/api-errors';
import { ContentTypeCardGrid, ContentTypePicker } from './ContentTypePicker';

interface DynamicCreateFormProps {
  gid: string;
  type: AllContentType | null;
  form: ReturnType<typeof useDynamicContentForm>;
  onTypeChange: (type: AllContentType) => void;
  onResetType: () => void;
  onDone: () => void;
}

export function DynamicCreateForm({
  gid,
  type,
  form,
  onTypeChange,
  onResetType,
  onDone,
}: DynamicCreateFormProps) {
  const createDynamic = useCreateDynamicContent(gid);
  const toast = useToast();
  const dynamicType = type && type !== 'image' ? type : null;
  const dynamicMeta = dynamicType ? DYNAMIC_TYPE_META[dynamicType] : null;
  const showDynamicParams = Boolean(dynamicMeta?.hasConfigurableParams);
  const showDynamicAudio = Boolean(
    dynamicMeta?.supportsAudio && form.config && isAudioDynamicConfig(form.config)
  );

  async function submitContent() {
    const parsed = form.submitConfig();
    if (!parsed.ok) {
      toast.error('配置有误', parsed.error);
      return;
    }
    try {
      await createDynamic.mutateAsync({
        kind: 'dynamic',
        config: parsed.config,
        frame_name: parsed.frameName,
        initial_data: parsed.dashboardData,
      });
      toast.success('已创建');
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
    <DynamicContentFormShell
      onSubmit={onSubmit}
      gridClassName="lg:grid-cols-2"
      preview={
        <DynamicFramePreview
          data={form.livePreviewData}
          pending={form.preview.isPending}
          hasConfig={!!form.config}
          caption={form.caption}
        />
      }
      header={
        <div className="space-y-3">
          {type ? (
            <ContentTypePicker value={type} onChange={onTypeChange} onBack={onResetType} />
          ) : (
            <ContentTypeCardGrid onChange={onTypeChange} />
          )}
          {type && (
            <p className="font-sans text-[12px] text-stone leading-relaxed">
              {TYPE_META[type].description}
            </p>
          )}
          {type && <div className="border-t border-line" />}
        </div>
      }
      fields={
        dynamicType && form.config ? (
          <DynamicContentFields
            type={dynamicType}
            config={form.config}
            frameName={form.frameName}
            onFrameNameChange={form.setFrameName}
            onConfigChange={form.changeConfig}
            showParams={showDynamicParams}
            showAudio={showDynamicAudio}
            dashboardData={form.dashboardData}
            onDashboardDataChange={form.setDashboardData}
            dashboardDataLabel="初始数据 JSON"
          />
        ) : null
      }
      actions={
        <FormActions
          onCancel={onDone}
          submitLabel="创建"
          disabled={!form.canSubmit}
          submitting={createDynamic.isPending}
        />
      }
    />
  );
}
