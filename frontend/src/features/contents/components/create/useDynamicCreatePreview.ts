import { useEffect, useRef, useState } from 'react';
import { DynamicConfig, type DynamicConfigT } from 'shared';
import type { UseMutationResult } from '@tanstack/react-query';
import type { AllContentType } from './content-create-types';
import { effectiveFrameName } from './frame-name';

type PreviewMutation = UseMutationResult<
  ArrayBuffer,
  Error,
  { config: DynamicConfigT; frameName?: string | null }
>;

export function useDynamicCreatePreview({
  type,
  config,
  frameName,
  preview,
}: {
  type: AllContentType | null;
  config: DynamicConfigT | null;
  frameName: string;
  preview: PreviewMutation;
}) {
  const [livePreviewData, setLivePreviewData] = useState<ArrayBuffer | null>(null);
  const previewSeq = useRef(0);

  function invalidatePreview() {
    previewSeq.current++;
    setLivePreviewData(null);
  }

  useEffect(() => {
    if (!config || type === 'image' || type === null) {
      invalidatePreview();
      return;
    }
    const parsed = DynamicConfig.safeParse(config);
    if (!parsed.success) {
      invalidatePreview();
      return;
    }
    const seq = ++previewSeq.current;
    const timer = setTimeout(() => {
      preview.mutate(
        { config: parsed.data, frameName: effectiveFrameName(type, parsed.data, frameName) },
        {
          onSuccess: (data) => {
            if (seq === previewSeq.current) setLivePreviewData(data);
          },
        }
      );
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, frameName, type]);

  return { livePreviewData, invalidatePreview };
}
