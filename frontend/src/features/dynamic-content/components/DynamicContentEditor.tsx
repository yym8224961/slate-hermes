// 动态内容编辑器 —— 创建 + 编辑共用。
//
// 创建：选类型 → 填配置 → 保存（POST /groups/:gid/contents/dynamic）
// 编辑：直接进配置面板（type 不可改）→ 保存（PATCH /contents/:contentId）

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Sparkles } from 'lucide-react';
import {
  DynamicConfig,
  type ContentSummaryT,
  type DynamicConfigT,
  type DynamicTypeT,
} from 'shared';
import {
  useContentImage,
  useCreateDynamicContent,
  usePreviewDynamicContent,
  useUpdateDynamicContent,
} from '@/features/contents/queries';
import { useToast } from '@/components/feedback/Toast';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { IconBlock } from '@/components/ui/IconBlock';
import { DoubleRule } from '@/components/ui/DoubleRule';
import { DynamicTypePicker } from '@/features/dynamic-content/components/DynamicTypePicker';
import { getApiErrorMessage } from '@/lib/api-error';
import { defaultConfig } from '@/features/dynamic-content/model/default-config';
import { DynamicConfigForm } from '@/features/dynamic-content/components/DynamicConfigForm';
import { FrameBitmapPreview } from '@/features/contents/components/FrameBitmapPreview';
import {
  defaultFrameName,
  effectiveFrameName,
  effectiveStatusBarText,
  hasVisibleDynamicConfig,
} from '@/features/contents/components/create/frame-name';

interface DynamicContentEditorProps {
  gid: string;
  /** edit 模式传现有动态内容；create 不传 */
  content?: ContentSummaryT;
  /** edit 模式下当前动态配置。 */
  initialConfig?: DynamicConfigT;
  initialType?: DynamicTypeT;
  onDone: () => void;
}

export function DynamicContentEditor({
  gid,
  content,
  initialConfig,
  initialType,
  onDone,
}: DynamicContentEditorProps) {
  const isEdit = !!content;
  const create = useCreateDynamicContent(gid);
  const update = useUpdateDynamicContent(gid);
  const submitting = isEdit ? update.isPending : create.isPending;
  const toast = useToast();

  const [type, setType] = useState<DynamicTypeT | null>(initialType ?? initialConfig?.type ?? null);
  const [frameName, setFrameName] = useState(content?.frame_name ?? '');
  const [config, setConfig] = useState<DynamicConfigT | null>(initialConfig ?? null);
  const initializedContentIdRef = useRef<string | null>(null);
  const initialConfigKey = useMemo(
    () => (initialConfig ? JSON.stringify(initialConfig) : null),
    [initialConfig]
  );
  const initializedConfigKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isEdit || !content || !initialConfig) return;
    if (
      initializedContentIdRef.current === content.content_id &&
      initializedConfigKeyRef.current === initialConfigKey
    ) {
      return;
    }
    initializedContentIdRef.current = content.content_id;
    initializedConfigKeyRef.current = initialConfigKey;

    const nextConfig = initialConfig;
    const nextType = initialType ?? nextConfig.type;
    setType(nextType);
    setFrameName(content.frame_name ?? defaultFrameName(nextType, nextConfig));
    setConfig(nextConfig);
  }, [isEdit, content, initialConfig, initialConfigKey, initialType]);

  // type 变化时（create 模式选了一个）→ 重置 config 为默认
  useEffect(() => {
    if (!isEdit && type && (!config || config.type !== type)) {
      setConfig(defaultConfig(type));
    }
  }, [type, isEdit, config]);

  const savedPreviewEnabled = !!content?.content_id && !!content?.image_etag;
  const savedPreview = useContentImage(
    content?.content_id ?? '',
    savedPreviewEnabled ? content!.image_etag : ''
  );

  // 实时预览（创建/编辑模式均支持）
  const livePreviewEnabled = !!(type && config);
  const preview = usePreviewDynamicContent(content?.content_id);
  const [livePreviewData, setLivePreviewData] = useState<ArrayBuffer | null>(null);
  const previewSeq = useRef(0);
  const visibleConfig = config ? hasVisibleDynamicConfig(config) : false;

  useEffect(() => {
    if (!livePreviewEnabled || !config) {
      previewSeq.current++;
      setLivePreviewData(null);
      return;
    }
    const parsed = DynamicConfig.safeParse(config);
    if (!parsed.success) {
      previewSeq.current++;
      setLivePreviewData(null);
      return;
    }
    const seq = ++previewSeq.current;
    const t = setTimeout(() => {
      preview.mutate(
        { config: parsed.data, frameName: effectiveFrameName(type, parsed.data, frameName) },
        {
          onSuccess: (data) => {
            if (seq === previewSeq.current) setLivePreviewData(data);
          },
        }
      );
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, frameName, livePreviewEnabled, type]);

  async function onSubmit() {
    if (!type || !config) return;
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
      if (isEdit) {
        await update.mutateAsync({
          contentId: content!.content_id,
          frameName: effectiveFrameName(type, parsed.data, frameName),
          config: parsed.data,
        });
        toast.success('已保存');
      } else {
        await create.mutateAsync({
          kind: 'dynamic',
          dynamic_type: type,
          config: parsed.data,
          frame_name: effectiveFrameName(type, parsed.data, frameName),
        });
        toast.success('已创建');
      }
      onDone();
    } catch (err) {
      toast.error(isEdit ? '保存失败' : '创建失败', getApiErrorMessage(err));
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
            {isEdit ? '编辑动态内容' : '新建动态内容'}
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
            <p className="font-sans text-[12px] text-stone mb-2 ml-0.5">设备预览</p>
            <DynamicPreview
              savedData={savedPreview.data}
              savedCacheKey={savedPreviewEnabled ? content!.image_etag : null}
              savedPending={savedPreviewEnabled && savedPreview.isPending}
              liveData={livePreviewData}
              livePending={preview.isPending}
              hasConfig={!!config}
              caption={effectiveStatusBarText(type, config, frameName)}
            />
          </div>

          {/* 表单 */}
          <div className="order-1 lg:order-2 space-y-6">
            {!isEdit && (
              <div>
                <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-2">
                  类型
                </p>
                <DynamicTypePicker value={type} onChange={setType} disabled={isEdit} />
              </div>
            )}

            {type === 'dashboard' && (
              <Input
                label="帧名称（选填，最多 64 字）"
                type="text"
                maxLength={64}
                value={frameName}
                onChange={(e) => setFrameName(e.target.value)}
                placeholder="如：运营数据"
              />
            )}

            {config && visibleConfig && (
              <DynamicConfigForm
                config={config}
                onChange={(next) => {
                  if (
                    next.type === 'weather' &&
                    config?.type === 'weather' &&
                    next.location_label !== config.location_label
                  ) {
                    setFrameName(defaultFrameName(next.type, next));
                  }
                  setConfig(next);
                }}
                contentId={content?.content_id}
              />
            )}

            {/* 操作按钮：粘在表单列底部，手机上全宽好点按 */}
            <div
              className={`flex gap-3 pt-5 border-t border-line sticky bottom-0 bg-paper pb-4 ${
                visibleConfig ? '' : 'lg:mt-[28px]'
              }`}
            >
              <Button variant="outline" onClick={onDone} className="flex-1">
                取消
              </Button>
              <Button
                onClick={onSubmit}
                disabled={!type || !config || submitting}
                iconLeft={!submitting ? <ArrowUp size={16} /> : undefined}
                className="flex-1"
              >
                {submitting ? <Spinner /> : isEdit ? '保存' : '创建'}
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
    <div className="bg-paper border border-ink relative overflow-hidden aspect-[4/3]">
      {(!displayData || pending) && <FrameBitmapPreview data={null} caption={caption} />}
      {!displayData && !pending && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <span className="font-serif italic text-[13px] text-stone-light">
            {hasConfig ? '修改参数后自动更新' : '选择类型后开始配置'}
          </span>
        </div>
      )}
      {pending && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <Spinner />
        </div>
      )}
      {displayData && !pending && (
        <FrameBitmapPreview
          data={displayData}
          cacheKey={liveData ? null : savedCacheKey}
          caption={caption}
        />
      )}
    </div>
  );
}
