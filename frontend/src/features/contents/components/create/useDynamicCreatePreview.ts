import { useCallback, useEffect, useRef, useState } from 'react';
import { DynamicConfig, type DynamicConfigT } from 'shared';
import type { UseMutationResult } from '@tanstack/react-query';
import type { AllContentType } from './content-create-types';
import { effectiveFrameName } from './frame-name';

type PreviewMutation = UseMutationResult<
  ArrayBuffer,
  Error,
  { config: DynamicConfigT; frameName?: string | null; data?: unknown }
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
  const { mutate } = preview;

  const invalidatePreview = useCallback(() => {
    previewSeq.current++;
    setLivePreviewData(null);
  }, []);

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
    setLivePreviewData(null);
    const timer = setTimeout(() => {
      mutate(
        {
          config: parsed.data,
          frameName: effectiveFrameName(type, parsed.data, frameName),
          data:
            parsed.data.type === 'dashboard'
              ? { version: 1, data: parsed.data.test_data }
              : undefined,
        },
        {
          onSuccess: (data) => {
            if (seq === previewSeq.current) setLivePreviewData(data);
          },
          onError: () => {
            if (seq === previewSeq.current) setLivePreviewData(null);
          },
        }
      );
    }, 800);
    return () => clearTimeout(timer);
  }, [config, frameName, invalidatePreview, mutate, type]);

  return { livePreviewData, invalidatePreview };
}
