// 动态内容编辑器 —— 创建 + 编辑共用。
//
// 创建：选类型 → 填配置 → 保存（POST /groups/:gid/contents/dynamic）
// 编辑：直接进配置面板（type 不可改）→ 保存（PATCH /contents/:contentId）

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Sparkles } from 'lucide-react';
import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  DynamicConfig,
  type ContentSummaryT,
  type DynamicConfigT,
  type DynamicTypeT,
} from 'shared';
import {
  useContentImage,
  useCreateDynamicContent,
  usePreviewDynamicContent,
  useUpdateContentAudio,
  useUpdateDynamicContent,
} from '../lib/queries';
import { useToast } from './Toast';
import { Input } from './Input';
import { Button } from './Button';
import { Spinner } from './Spinner';
import { IconBlock } from './IconBlock';
import { DoubleRule } from './DoubleRule';
import { DynamicTypePicker } from './DynamicTypePicker';
import { decodeBppImage, isValidBppLength } from '../lib/image';
import { StatusBarOverlay } from './StatusBarOverlay';
import { getApiErrorMessage } from '../lib/api-error';
import { AudioDropzone } from './image-content-editor-controls/AudioDropzone';
import { defaultConfig } from './dynamicDefaultConfig';
import { DynamicConfigForm } from './DynamicConfigForm';

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
  const updateAudio = useUpdateContentAudio(gid);
  const submitting = isEdit ? update.isPending || updateAudio.isPending : create.isPending;
  const toast = useToast();

  const [type, setType] = useState<DynamicTypeT | null>(initialType ?? null);
  const [caption, setCaption] = useState(content?.title ?? '');
  const [config, setConfig] = useState<DynamicConfigT | null>(initialConfig ?? null);
  const [audioFile, setAudioFile] = useState<File | null>(null);

  // type 变化时（create 模式选了一个）→ 重置 config 为默认
  useEffect(() => {
    if (!isEdit && type && (!config || config.type !== type)) {
      setConfig(defaultConfig(type));
    }
  }, [type, isEdit, config]);

  // 已保存的预览（edit 模式初始加载用）
  const savedPreviewEnabled = !!content?.content_id && !!content?.image_etag;
  const img = useContentImage(
    content?.content_id ?? '',
    savedPreviewEnabled ? content!.image_etag : ''
  );

  // 实时预览（创建/编辑模式均支持）
  const livePreviewEnabled = !!(type && config);
  const preview = usePreviewDynamicContent(content?.content_id);
  const [livePreviewData, setLivePreviewData] = useState<ArrayBuffer | null>(null);

  useEffect(() => {
    if (!livePreviewEnabled || !config) return;
    const parsed = DynamicConfig.safeParse(config);
    if (!parsed.success) return;
    const t = setTimeout(() => {
      preview.mutate(
        { config: parsed.data, title: caption.trim() || null },
        { onSuccess: (data) => setLivePreviewData(data) }
      );
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, caption, livePreviewEnabled]);

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
          title: caption.trim() || null,
          config: parsed.data,
        });
        if (audioFile) {
          await updateAudio.mutateAsync({
            contentId: content!.content_id,
            audio: audioFile,
          });
        }
        toast.success('已保存');
      } else {
        const created = await create.mutateAsync({
          kind: 'dynamic',
          dynamic_type: type,
          config: parsed.data,
          title: caption.trim() || null,
        });
        if (audioFile) {
          await updateAudio.mutateAsync({
            contentId: created.content_id,
            audio: audioFile,
          });
        }
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
            动态内容由服务端定时渲染下发，设备显示时会使用最新版本。
          </p>
        </div>
      </header>

      <DoubleRule className="mt-3" />

      <div className="mt-6 fade-up fade-up-1">
        <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-6 lg:gap-8">
          {/* 预览 */}
          <div className="order-2 lg:order-1">
            <p className="font-sans text-[12px] text-stone mb-2 ml-0.5">
              预览 · 1bpp · {FRAME_WIDTH}×{FRAME_HEIGHT}
            </p>
            <DynamicPreview
              img={img}
              savedPreviewEnabled={savedPreviewEnabled}
              liveData={livePreviewData}
              livePending={preview.isPending}
              hasConfig={!!config}
              caption={caption}
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

            <Input
              label="标题（选填，最多 64 字）"
              type="text"
              maxLength={64}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="如：北京天气"
            />

            {config && (
              <DynamicConfigForm
                config={config}
                onChange={setConfig}
                contentId={content?.content_id}
              />
            )}

            <AudioDropzone
              gid={gid}
              hasExistingAudio={isEdit && !!content!.audio_etag}
              editingContentId={isEdit ? content!.content_id : null}
              audioFile={audioFile}
              onPick={setAudioFile}
            />

            {/* 操作按钮：粘在表单列底部，手机上全宽好点按 */}
            <div className="flex gap-3 pt-5 border-t border-line sticky bottom-0 bg-paper pb-4">
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

// 预览 canvas —— liveData 优先于 savedImg（实时预览覆盖上次保存的快照）。
function DynamicPreview({
  img,
  savedPreviewEnabled,
  liveData,
  livePending,
  hasConfig,
  caption,
}: {
  img: ReturnType<typeof useContentImage>;
  savedPreviewEnabled: boolean;
  liveData: ArrayBuffer | null;
  livePending: boolean;
  hasConfig: boolean;
  caption?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 画已保存的预览
  useEffect(() => {
    if (liveData || !img.data || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    const bytes = new Uint8Array(img.data);
    if (!isValidBppLength(bytes)) return;
    ctx.putImageData(decodeBppImage(bytes), 0, 0);
  }, [img.data, liveData]);

  // 画实时预览（覆盖已保存预览）
  useEffect(() => {
    if (!liveData || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    const bytes = new Uint8Array(liveData);
    if (!isValidBppLength(bytes)) return;
    ctx.putImageData(decodeBppImage(bytes), 0, 0);
  }, [liveData]);

  const showCanvas = savedPreviewEnabled || liveData;
  const showSpinner = livePending || (savedPreviewEnabled && img.isPending && !liveData);

  return (
    <div className="bg-paper border border-ink relative overflow-hidden aspect-[4/3]">
      {!showCanvas && !showSpinner && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="font-serif italic text-[13px] text-stone-light">
            {hasConfig ? '修改参数后自动更新' : '选择类型后开始配置'}
          </span>
        </div>
      )}
      {showSpinner && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </div>
      )}
      {/* canvas 始终挂载，只在有数据时才有内容 */}
      <canvas
        ref={canvasRef}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        className="block w-full h-full"
        style={{ display: showCanvas && !showSpinner ? 'block' : 'none' }}
      />
      <StatusBarOverlay caption={caption} />
    </div>
  );
}
