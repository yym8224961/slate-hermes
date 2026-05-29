// 统一新建编辑器 — 图片 + 所有动态类型在同一页面切换。
// 仅用于新建；编辑流程仍使用各自的 ImageContentEditor / DynamicContentEditor。

import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { DynamicConfig, isAudioDynamicConfig, type DynamicConfigT } from 'shared';
import {
  useCreateImageContent,
  useCreateDynamicContent,
  useGenerateContentTts,
  usePreviewDynamicContent,
} from '@/features/contents/queries';
import { useToast } from '@/components/feedback/Toast';
import { Input } from '@/components/ui/Input';
import { FormActions } from '@/components/ui/FormActions';
import { PageHeader } from '@/components/layout/PageHeader';
import { FormSection } from '@/components/ui/FormSection';
import { useImageContentForm } from '@/features/contents/components/image-editor/useImageContentForm';
import { ImageFormBody } from '@/features/contents/components/image-editor/ImageFormBody';
import { defaultConfig } from '@/features/dynamic/model/default-config';
import { DynamicConfigForm } from '@/features/dynamic/components/DynamicConfigForm';
import { DynamicAudioSection } from '@/features/dynamic/components/config/DynamicAudioSection';
import { getApiErrorMessage } from '@/lib/api-errors';
import { ContentTypeCardGrid, ContentTypePicker } from './ContentTypePicker';
import { DynamicFramePreview } from '@/features/dynamic/components/preview/DynamicPreview';
import {
  defaultFrameName,
  effectiveFrameName,
  effectiveStatusBarText,
} from '@/features/contents/model/frame-name';
import {
  TYPE_META,
  shouldRenderParams,
  type AllContentType,
} from '@/features/contents/model/type-meta';
import { useDynamicPreview } from '@/features/dynamic/hooks/useDynamicPreview';
import { frameNameForSyncedDynamicConfigChange } from '@/features/dynamic/model/frame-name-sync';

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

  // 通用
  const [type, setType] = useState<AllContentType | null>(null);
  const [dynamicFrameName, setDynamicFrameName] = useState('');

  // 动态类型专属
  const [config, setConfig] = useState<DynamicConfigT | null>(null);
  const activeFrameName = type === 'image' ? imageForm.frameName : dynamicFrameName;
  const preview = usePreviewDynamicContent(undefined);
  const { livePreviewData, invalidatePreview } = useDynamicPreview({
    type,
    config,
    frameName: activeFrameName,
    preview,
  });

  function handleTypeChange(t: AllContentType) {
    if (t === type) return;
    invalidatePreview();
    setType(t);
    if (t === 'image') {
      setDynamicFrameName('');
      setConfig(null);
    } else {
      const nextConfig = defaultConfig(t);
      setDynamicFrameName(defaultFrameName(t, nextConfig));
      imageForm.reset();
      setConfig(nextConfig);
    }
  }

  function resetTypeSelection() {
    invalidatePreview();
    setType(null);
    setDynamicFrameName('');
    imageForm.reset();
    setConfig(null);
  }

  const submitting = createImage.isPending || createDynamic.isPending || generateTts.isPending;
  const canSubmit = type === 'image' ? imageForm.canCreate : !!(type && config);

  async function submitContent() {
    if (!type) return;
    try {
      if (type === 'image') {
        if (!imageForm.imageFile) return;
        const fd = await imageForm.buildFormData();
        const created = await createImage.mutateAsync(fd);
        if (imageForm.wantsTts) {
          try {
            await generateTts.mutateAsync({
              contentId: created.id,
              body: { text: imageForm.trimmedTtsText, voice: imageForm.ttsVoice },
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
          frame_name: effectiveFrameName(type, parsed.data, dynamicFrameName),
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

  const frameNamePlaceholder = type === 'dashboard' ? '如：AI 使用统计' : '';

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
              showSafeArea={Boolean(imageForm.imageFile)}
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
          <form onSubmit={onSubmit} className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
            {/* 预览（desktop 左侧 / mobile 排在控件下方）*/}
            <div className="order-2 min-w-0 lg:order-1">
              <p className="font-mono text-[10px] leading-5 text-stone uppercase tracking-[0.18em] ml-0.5 mb-2">
                设备预览
              </p>
              <DynamicFramePreview
                data={livePreviewData}
                pending={preview.isPending}
                hasConfig={!!config}
                caption={effectiveStatusBarText(type, config, dynamicFrameName)}
              />
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
                  {/* 帧名称（仅外部数据）*/}
                  {type === 'dashboard' && (
                    <FormSection label="帧名称（选填，最多 64 字）">
                      <Input
                        type="text"
                        maxLength={64}
                        value={activeFrameName}
                        onChange={(e) => setDynamicFrameName(e.target.value)}
                        placeholder={frameNamePlaceholder}
                      />
                    </FormSection>
                  )}

                  {/* 类型参数 */}
                  {shouldRenderParams(type) && (
                    <FormSection label="类型参数">
                      {config && (
                        <DynamicConfigForm
                          config={config}
                          onChange={(next) => {
                            const nextFrameName = frameNameForSyncedDynamicConfigChange(
                              config,
                              next
                            );
                            if (nextFrameName) setDynamicFrameName(nextFrameName);
                            setConfig(next);
                          }}
                        />
                      )}
                    </FormSection>
                  )}

                  {/* 音频 */}
                  {TYPE_META[type].supportsAudio && (
                    <FormSection label="音频">
                      {config && isAudioDynamicConfig(config) && (
                        <DynamicAudioSection config={config} onChange={setConfig} />
                      )}
                    </FormSection>
                  )}

                  {/* 操作按钮：粘在表单列底部 */}
                  <FormActions
                    onCancel={onDone}
                    submitLabel="创建"
                    disabled={!canSubmit}
                    submitting={submitting}
                  />
                </>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
