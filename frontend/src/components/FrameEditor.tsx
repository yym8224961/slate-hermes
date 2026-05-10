// 帧编辑器 — create + edit 共用同一套 form，作为独立页面渲染。
//
// 拆分:
//   PreviewCanvas   — 1bpp 预览 + 拖拽/缩放交互
//   ImageDropzone   — 选图(可选)
//   AudioDropzone   — 选音频 + 删除已有音频
//   DitherControls  — 缩放 / 抖动算法 / 阈值

import { useState, useRef } from 'react';
import { ArrowLeft, ArrowUp, Frame } from 'lucide-react';
import { FRAME_WIDTH, FRAME_HEIGHT, BW_THRESHOLD_DEFAULT, DEFAULT_DITHER_MODE } from 'shared';
import type { FrameSummaryT, DitherMode } from 'shared';
import { useCreateFrame, useUpdateFrame, useFrameImage } from '../lib/queries';
import { useToast } from './Toast';
import { Input } from './Input';
import { Button } from './Button';
import { Spinner } from './Spinner';
import { IconBlock } from './IconBlock';
import { PreviewCanvas } from './frame-editor/PreviewCanvas';
import { ImageDropzone } from './frame-editor/ImageDropzone';
import { AudioDropzone } from './frame-editor/AudioDropzone';
import { DitherControls } from './frame-editor/DitherControls';

interface FrameEditorProps {
  gid: string;
  /** edit 模式传现有 frame;create 模式不传 */
  frame?: FrameSummaryT;
  onDone: () => void;
}

export function FrameEditor({ gid, frame, onDone }: FrameEditorProps) {
  const isEdit = !!frame;
  const createFrame = useCreateFrame(gid);
  const updateFrame = useUpdateFrame(gid);
  const submitting = isEdit ? updateFrame.isPending : createFrame.isPending;
  const toast = useToast();

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [threshold, setThreshold] = useState(BW_THRESHOLD_DEFAULT);
  const [mode, setMode] = useState<DitherMode>(DEFAULT_DITHER_MODE);
  const [caption, setCaption] = useState(isEdit ? (frame.caption ?? '') : '');
  const [showSafeArea, setShowSafeArea] = useState(true);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const previewRef = useRef<HTMLCanvasElement>(null);

  const existingImg = useFrameImage(
    gid,
    frame?.sort_order ?? -1,
    isEdit && !imageFile ? frame!.image_etag : ''
  );

  const captionChanged = isEdit && caption !== (frame.caption ?? '');
  const canSubmit = isEdit ? !!imageFile || !!audioFile || captionChanged : !!imageFile;

  function resetCrop() {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  function onImagePick(f: File | null) {
    setImageFile(f);
    resetCrop();
  }

  async function onSubmit() {
    const fd = new FormData();
    if (imageFile) {
      const canvas = previewRef.current;
      if (canvas) {
        const blob = await new Promise<Blob>((resolve) => {
          canvas.toBlob((b) => resolve(b!), 'image/png');
        });
        fd.append('image', blob, 'cropped.png');
      }
      fd.append('threshold', String(threshold));
      fd.append('mode', mode);
    }
    if (audioFile) fd.append('audio', audioFile);
    fd.append('caption', caption.trim());

    try {
      if (isEdit) {
        await updateFrame.mutateAsync({ seq: frame!.sort_order, form: fd });
        toast.success('帧已保存');
      } else {
        await createFrame.mutateAsync(fd);
        toast.success('帧已新建');
      }
      onDone();
    } catch (err) {
      const env = (err as { response?: { data?: { message?: string; error?: string } } })?.response
        ?.data;
      toast.error(isEdit ? '保存失败' : '新建失败', env?.message ?? env?.error);
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
        <IconBlock size="xl" tone="soft">
          <Frame size={28} />
        </IconBlock>
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-[32px] sm:text-[40px] font-bold leading-tight truncate tracking-tight">
            {isEdit ? `编辑第 ${frame!.sort_order} 帧` : '新建一帧'}
          </h1>
          <p className="font-serif italic text-[14px] text-stone mt-1.5">
            {isEdit ? '改顺序请在组内用拖拽。' : '追加至列尾，可拖拽改序。'}
          </p>
        </div>
      </header>

      <div className="mt-5 flex flex-col gap-[3px]">
        <div className="h-px bg-ink" />
        <div className="h-0.5 bg-ink" />
      </div>

      <div className="mt-6 fade-up fade-up-1">
        <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-6 lg:gap-8">
          {/* 预览(desktop 左 / mobile 排在控件下) */}
          <div className="order-2 lg:order-1">
            <div>
              <div className="flex items-baseline justify-between mb-2 ml-0.5">
                <p className="font-sans text-[12px] text-stone">
                  预览 · 1bpp · {FRAME_WIDTH}×{FRAME_HEIGHT}
                </p>
                <button
                  type="button"
                  onClick={() => setShowSafeArea((v) => !v)}
                  className="font-sans text-[11px] text-stone border-b border-stone hover:border-ink hover:text-ink transition-colors"
                >
                  {showSafeArea ? '隐藏安全区' : '显示安全区'}
                </button>
              </div>
              <PreviewCanvas
                canvasRef={previewRef}
                imageFile={imageFile}
                existingImage={isEdit ? existingImg.data : undefined}
                threshold={threshold}
                mode={mode}
                caption={caption}
                showSafeArea={showSafeArea}
                scale={scale}
                offset={offset}
                onOffsetChange={setOffset}
              />
              <p className="font-serif italic text-[11px] text-stone-light mt-2 text-center">
                {imageFile
                  ? '拖拽定位 · 滑块缩放 · 顶部白条为设备状态栏'
                  : isEdit
                    ? existingImg.isPending
                      ? '加载原图…'
                      : '原图当前样子'
                    : '选图后此处显示阈值化预览'}
              </p>
            </div>
          </div>

          {/* 控件:① 标题 ② 图(含裁剪/抖动/阈值) ③ 音频 */}
          <div className="order-1 lg:order-2 space-y-6">
            <Input
              label="标题（选填，最多 64 字）"
              type="text"
              maxLength={64}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="如：挖掘机"
              autoFocus={!isEdit}
            />

            <div className="space-y-4">
              <p className="font-sans text-[12px] text-stone ml-0.5">
                图片{isEdit ? ' · 不传则保留原图' : ''}
              </p>
              <ImageDropzone isEdit={isEdit} imageFile={imageFile} onPick={onImagePick} />
              <DitherControls
                mode={mode}
                onModeChange={setMode}
                threshold={threshold}
                onThresholdChange={setThreshold}
                hasImage={!!imageFile}
                scale={scale}
                onScaleChange={setScale}
                onResetCrop={resetCrop}
              />
            </div>

            <AudioDropzone
              gid={gid}
              hasExistingAudio={isEdit && !!frame!.audio_etag}
              editingSeq={isEdit ? frame!.sort_order : null}
              audioFile={audioFile}
              onPick={setAudioFile}
            />
          </div>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-end gap-3 border-t border-ink pt-5 pb-8">
        <Button variant="outline" onClick={onDone}>
          取消
        </Button>
        <Button
          onClick={onSubmit}
          disabled={!canSubmit || submitting}
          iconLeft={!submitting ? <ArrowUp size={16} /> : undefined}
        >
          {submitting ? <Spinner /> : isEdit ? '保存' : '上传'}
        </Button>
      </div>
    </div>
  );
}
