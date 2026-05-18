import { Spinner } from '@/components/ui/Spinner';
import { FrameBitmapPreview } from '@/features/contents/components/FrameBitmapPreview';

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
    <div className="bg-paper border border-ink relative overflow-hidden aspect-[4/3]">
      {(!liveData || livePending) && <FrameBitmapPreview data={null} caption={caption} />}
      {!liveData && !livePending && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <span className="font-serif italic text-[13px] text-stone-light">
            {hasConfig ? '修改参数后自动更新' : '选择类型后开始配置'}
          </span>
        </div>
      )}
      {livePending && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <Spinner />
        </div>
      )}
      {liveData && !livePending && <FrameBitmapPreview data={liveData} caption={caption} />}
    </div>
  );
}
