import { Spinner } from '@/components/ui/Spinner';
import { FrameBitmapPreview } from '@/features/contents/components/bitmap/FrameBitmapPreview';

export function DynamicFramePreview({
  data,
  pending,
  hasConfig,
  caption,
}: {
  data: ArrayBuffer | null;
  pending: boolean;
  hasConfig: boolean;
  caption?: string | null;
}) {
  const showPlaceholder = !data;
  return (
    <div className="bg-paper border border-ink relative overflow-hidden aspect-[4/3]">
      <FrameBitmapPreview data={data} caption={caption} />
      {showPlaceholder && !pending && (
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
    </div>
  );
}

export function SavedOrLiveDynamicFramePreview({
  savedData,
  savedPending,
  liveData,
  livePending,
  hasConfig,
  caption,
}: {
  savedData?: ArrayBuffer;
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
      pending={pending}
      hasConfig={hasConfig}
      caption={caption}
    />
  );
}
