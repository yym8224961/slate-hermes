// 动态内容编辑器 —— 编辑动态内容配置。

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Sparkles } from 'lucide-react';
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
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { IconBlock } from '@/components/ui/IconBlock';
import { DoubleRule } from '@/components/ui/DoubleRule';
import { FormSection } from '@/components/ui/FormSection';
import { getApiErrorMessage } from '@/lib/api-error';
import {
  DynamicConfigForm,
  DynamicAudioSection,
} from '@/features/dynamic-content/components/DynamicConfigForm';
import {
  defaultFrameName,
  effectiveFrameName,
  effectiveStatusBarText,
} from '@/features/contents/components/create/frame-name';
import { TYPE_META, shouldRenderParams } from '@/features/contents/components/create/type-meta';
import { useDynamicCreatePreview } from '@/features/contents/components/create/useDynamicCreatePreview';
import { DynamicFramePreview } from '@/features/contents/components/create/DynamicCreatePreview';

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
  const [frameName, setFrameName] = useState(content.frame_name ?? '');
  const [config, setConfig] = useState<DynamicConfigT>(initialConfig);
  const initializedContentIdRef = useRef<string | null>(null);
  const initialConfigKey = useMemo(() => JSON.stringify(initialConfig), [initialConfig]);
  const initializedConfigKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      initializedContentIdRef.current === content.id &&
      initializedConfigKeyRef.current === initialConfigKey
    ) {
      return;
    }
    initializedContentIdRef.current = content.id;
    initializedConfigKeyRef.current = initialConfigKey;

    const nextConfig = initialConfig;
    const nextType = initialType;
    setType(nextType);
    setFrameName(content.frame_name ?? defaultFrameName(nextType, nextConfig));
    setConfig(nextConfig);
  }, [content, initialConfig, initialConfigKey, initialType]);

  const savedPreviewEnabled = !!content.image_etag;
  const savedPreview = useContentImage(content.id, savedPreviewEnabled ? content.image_etag : '');

  // 实时预览
  const preview = usePreviewDynamicContent(content.id);
  const { livePreviewData } = useDynamicCreatePreview({ type, config, frameName, preview });
  const showParams = shouldRenderParams(type);

  async function onSubmit() {
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
      toast.success('已保存');
      onDone();
    } catch (err) {
      toast.error('保存失败', getApiErrorMessage(err));
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
          <Sparkles size={24} />
        </IconBlock>
        <div className="flex-1 min-w-0">
          <h1 className="font-serif text-[32px] sm:text-[40px] font-bold leading-[1.2] truncate tracking-tight">
            编辑动态内容
          </h1>
          <p className="font-sans text-[13px] text-stone mt-1.5 leading-relaxed">
            动态内容由服务端生成 400×300 1bpp 帧，设备端直接显示并叠加状态栏。
          </p>
        </div>
      </header>

      <DoubleRule className="mt-3" />

      <div className="mt-6 fade-up fade-up-1">
        <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-6 lg:gap-8">
          {/* 预览 */}
          <div className="order-2 lg:order-1">
            <p className="font-mono text-[10px] leading-5 text-stone uppercase tracking-[0.18em] ml-0.5 mb-2">
              设备预览
            </p>
            <DynamicPreview
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
                    if (
                      (next.type === 'weather' &&
                        config?.type === 'weather' &&
                        next.location_label !== config.location_label) ||
                      (next.type === 'weather_alert' &&
                        config?.type === 'weather_alert' &&
                        next.province !== config.province)
                    ) {
                      setFrameName(defaultFrameName(next.type, next));
                    }
                    setConfig(next);
                  }}
                  contentId={content.id}
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
            <div className="flex gap-3 pt-6 border-t border-line sticky bottom-0 bg-paper pb-6">
              <Button variant="outline" onClick={onDone} className="flex-1">
                取消
              </Button>
              <Button
                onClick={onSubmit}
                disabled={submitting}
                iconLeft={!submitting ? <ArrowUp size={16} /> : undefined}
                className="flex-1"
              >
                {submitting ? <Spinner /> : '保存'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DynamicPreview({
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
