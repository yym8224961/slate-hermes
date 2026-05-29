// 动态内容编辑器 —— 编辑动态内容配置。

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { Sparkles } from 'lucide-react';
import {
  DynamicConfig,
  isAudioDynamicConfig,
  type ContentDetailT,
  type DynamicConfigT,
  type DynamicTypeT,
} from 'shared';
import {
  useContentImage,
  usePreviewDynamicContent,
  useUpdateDynamicContent,
} from '@/features/contents/queries';
import { useToast } from '@/components/feedback/Toast';
import { Input } from '@/components/ui/Input';
import { FormActions } from '@/components/ui/FormActions';
import { PageHeader } from '@/components/layout/PageHeader';
import { FormSection } from '@/components/ui/FormSection';
import { getApiErrorMessage } from '@/lib/api-errors';
import { DynamicConfigForm } from '@/features/dynamic/components/DynamicConfigForm';
import { DynamicAudioSection } from '@/features/dynamic/components/config/DynamicAudioSection';
import {
  defaultFrameName,
  effectiveFrameName,
  effectiveStatusBarText,
} from '@/features/contents/model/frame-name';
import { TYPE_META, shouldRenderParams } from '@/features/contents/model/type-meta';
import { useDynamicPreview } from '@/features/dynamic/hooks/useDynamicPreview';
import { useDynamicEditorBaselineSync } from '@/features/dynamic/hooks/useDynamicEditorBaselineSync';
import { DynamicFramePreview } from '@/features/dynamic/components/preview/DynamicPreview';
import { canonicalJsonKey } from '@/lib/json';
import { frameNameForSyncedDynamicConfigChange } from '@/features/dynamic/model/frame-name-sync';

interface DynamicContentEditorProps {
  gid: string;
  content: ContentDetailT;
  initialConfig: DynamicConfigT;
  initialType: DynamicTypeT;
  onDone: () => void;
}

export function DynamicContentEditor({
  gid,
  content,
  initialConfig,
  initialType,
  onDone,
}: DynamicContentEditorProps) {
  const update = useUpdateDynamicContent(gid);
  const submitting = update.isPending;
  const toast = useToast();

  const [type, setType] = useState<DynamicTypeT>(initialType);
  const [frameName, setFrameName] = useState(
    () => content.frame_name ?? defaultFrameName(initialType, initialConfig)
  );
  const [config, setConfig] = useState<DynamicConfigT>(initialConfig);
  const configKey = useMemo(() => canonicalJsonKey(config), [config]);
  const { baseline, setBaseline } = useDynamicEditorBaselineSync({
    contentId: content.id,
    serverType: initialType,
    serverFrameName: content.frame_name,
    serverConfig: initialConfig,
    type,
    frameName,
    configKey,
    setType,
    setFrameName,
    setConfig,
  });
  const dirty = useMemo(
    () =>
      type !== baseline.type ||
      frameName !== baseline.frameName ||
      configKey !== baseline.configKey,
    [baseline.configKey, baseline.frameName, baseline.type, configKey, frameName, type]
  );

  const savedPreviewEnabled = !!content.image_etag;
  const savedPreview = useContentImage(content.id, content.image_etag ?? null);

  // 实时预览
  const preview = usePreviewDynamicContent(content.id);
  const dashboardData = useMemo(
    () => (type === 'dashboard' ? dashboardDataRecord(content.dynamic_data) : null),
    [content.dynamic_data, type]
  );
  const { livePreviewData } = useDynamicPreview({
    type,
    config,
    frameName,
    dashboardData,
    preview,
  });
  const showParams = shouldRenderParams(type);

  const onSubmit = useCallback(async () => {
    // 提交前用 shared 的 DynamicConfig zod 校验，避免后端 400 后才知道错。
    // 失败时把第一个 issue 反馈给用户。
    const parsed = DynamicConfig.safeParse(config);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join('.') || 'config';
      toast.error('配置有误', `${path}: ${first?.message ?? '请检查'}`);
      return;
    }
    try {
      await update.mutateAsync({
        contentId: content.id,
        frameName: effectiveFrameName(type, parsed.data, frameName),
        config: parsed.data,
      });
      setBaseline({
        contentId: content.id,
        type,
        frameName,
        configKey,
      });
      toast.success('已保存');
      onDone();
    } catch (err) {
      toast.error('保存失败', getApiErrorMessage(err));
    }
  }, [config, configKey, content.id, frameName, onDone, setBaseline, toast, type, update]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void onSubmit();
    },
    [onSubmit]
  );

  return (
    <div>
      <PageHeader
        onBack={onDone}
        icon={<Sparkles size={24} />}
        title="编辑动态内容"
        subtitle="动态内容由服务端生成 400×300 1bpp 帧，设备端直接显示并叠加状态栏。"
      />

      <div className="mt-6 fade-up fade-up-1">
        <form
          onSubmit={handleSubmit}
          className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-6 lg:gap-8"
        >
          {/* 预览 */}
          <div className="order-2 lg:order-1">
            <p className="font-mono text-[10px] leading-5 text-stone uppercase tracking-[0.18em] ml-0.5 mb-2">
              设备预览
            </p>
            <SavedOrLivePreview
              savedData={savedPreview.data}
              savedCacheKey={savedPreviewEnabled ? content.image_etag : null}
              savedPending={savedPreviewEnabled && savedPreview.isPending}
              liveData={livePreviewData}
              livePending={preview.isPending}
              hasConfig={!!config}
              caption={effectiveStatusBarText(type, config, frameName)}
            />
          </div>

          {/* 表单 */}
          <div className="order-1 lg:order-2 lg:mt-7 space-y-6">
            {/* 类型块 — 12px 等距：picker/chip · description · divider */}
            <div className="space-y-3">
              <p className="font-sans text-[12px] text-stone leading-relaxed">
                {TYPE_META[type].description}
              </p>
              <div className="border-t border-line" />
            </div>

            {/* 帧名称（仅外部数据）*/}
            {type === 'dashboard' && (
              <FormSection label="帧名称（选填，最多 64 字）">
                <Input
                  type="text"
                  maxLength={64}
                  value={frameName}
                  onChange={(e) => setFrameName(e.target.value)}
                  placeholder="如：AI 使用统计"
                />
              </FormSection>
            )}

            {/* 类型参数 */}
            {showParams && (
              <FormSection label="类型参数">
                <DynamicConfigForm
                  config={config}
                  onChange={(next) => {
                    const nextFrameName = frameNameForSyncedDynamicConfigChange(config, next);
                    if (nextFrameName) setFrameName(nextFrameName);
                    setConfig(next);
                  }}
                  contentId={content.id}
                  dashboardData={dashboardData ?? undefined}
                  dashboardDataLabel="当前数据 JSON"
                />
              </FormSection>
            )}

            {/* 音频 */}
            {TYPE_META[type].supportsAudio && isAudioDynamicConfig(config) && (
              <FormSection label="音频">
                <DynamicAudioSection config={config} onChange={setConfig} />
              </FormSection>
            )}

            {/* 操作按钮 */}
            <FormActions
              onCancel={onDone}
              submitLabel="保存"
              disabled={!dirty}
              submitting={submitting}
            />
          </div>
        </form>
      </div>
    </div>
  );
}

function dashboardDataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function SavedOrLivePreview({
  savedData,
  savedCacheKey,
  savedPending,
  liveData,
  livePending,
  hasConfig,
  caption,
}: {
  savedData?: ArrayBuffer;
  savedCacheKey?: string | null;
  savedPending?: boolean;
  liveData: ArrayBuffer | null;
  livePending: boolean;
  hasConfig: boolean;
  caption?: string | null;
}) {
  const displayData = liveData ?? savedData ?? null;
  const pending = livePending || (!liveData && Boolean(savedPending));

  return (
    <DynamicFramePreview
      data={displayData}
      cacheKey={liveData ? null : savedCacheKey}
      pending={pending}
      hasConfig={hasConfig}
      caption={caption}
    />
  );
}
