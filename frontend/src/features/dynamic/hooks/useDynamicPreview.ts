import { useCallback, useEffect, useRef, useState } from 'react';
import { DynamicConfig, type DynamicConfigT } from 'shared';
import type { UseMutationResult } from '@tanstack/react-query';
import type { AllContentType } from '@/features/contents/model/type-meta';
import { effectiveFrameName } from '@/features/contents/model/frame-name';

type PreviewMutation = UseMutationResult<
  ArrayBuffer,
  Error,
  { config: DynamicConfigT; frameName?: string | null; data?: unknown; signal?: AbortSignal }
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
  // React Query v5 exposes a stable mutate reference; keeping it as a named
  // dependency makes the debounce effect explicit without depending on the
  // whole mutation result object.
  const previewMutate = preview.mutate;

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
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewMutate(
        {
          config: parsed.data,
          frameName: effectiveFrameName(type, parsed.data, frameName),
          data:
            parsed.data.type === 'dashboard'
              ? { version: 1, data: parsed.data.test_data }
              : undefined,
          signal: controller.signal,
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
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [config, debounceMs, frameName, invalidatePreview, previewMutate, type]);

  return { livePreviewData, invalidatePreview };
}
