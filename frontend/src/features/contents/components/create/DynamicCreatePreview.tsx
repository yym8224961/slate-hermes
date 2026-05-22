import { Spinner } from '@/components/ui/Spinner';
import { FrameBitmapPreview } from '@/features/contents/components/FrameBitmapPreview';

export function DynamicFramePreview({
  data,
  cacheKey,
  pending,
  hasConfig,
  caption,
}: {
  data: ArrayBuffer | null;
  cacheKey?: string | null;
  pending: boolean;
  hasConfig: boolean;
  caption?: string | null;
}) {
  return (
    <div className="bg-paper border border-ink relative overflow-hidden aspect-[4/3]">
      {(!data || pending) && <FrameBitmapPreview data={null} caption={caption} />}
      {!data && !pending && (
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
      {data && !pending && (
        <FrameBitmapPreview data={data} cacheKey={cacheKey ?? null} caption={caption} />
      )}
    </div>
  );
}

export function DynamicCreatePreview({
  liveData,
  livePending,
  hasConfig,
  caption,
}: {
  liveData: ArrayBuffer | null;
  livePending: boolean;
  hasConfig: boolean;
  caption?: string | null;
}) {
  return (
    <DynamicFramePreview
      data={liveData}
      pending={livePending}
      hasConfig={hasConfig}
      caption={caption}
    />
  );
}
