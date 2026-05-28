import { useCallback, useEffect, useRef, useState } from 'react';
import { DynamicConfig, type DynamicConfigT } from 'shared';
import type { UseMutationResult } from '@tanstack/react-query';
import type { AllContentType } from '@/features/contents/model/type-meta';
import { effectiveFrameName } from '@/features/contents/model/frame-name';

type PreviewMutation = UseMutationResult<
  ArrayBuffer,
  Error,
  { config: DynamicConfigT; frameName?: string | null; data?: unknown }
>;

export function useDynamicPreview({
  type,
  config,
  frameName,
  preview,
  debounceMs = 800,
}: {
  type: AllContentType | null;
  config: DynamicConfigT | null;
  frameName: string;
  preview: PreviewMutation;
  debounceMs?: number;
}) {
  const [livePreviewData, setLivePreviewData] = useState<ArrayBuffer | null>(null);
  const previewSeq = useRef(0);
  const mutateRef = useRef(preview.mutate);

  useEffect(() => {
    mutateRef.current = preview.mutate;
  }, [preview.mutate]);

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
      mutateRef.current(
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
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [config, debounceMs, frameName, invalidatePreview, type]);

  return { livePreviewData, invalidatePreview };
}
