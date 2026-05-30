import { useCallback } from 'react';
import type { DitherMode } from 'shared';

export function useImageFormSubmit({
  imageFile,
  audioFile,
  previewRef,
  frameName,
  threshold,
  mode,
}: {
  imageFile: File | null;
  audioFile: File | null;
  previewRef: React.RefObject<HTMLCanvasElement | null>;
  frameName: string;
  threshold: number;
  mode: DitherMode;
}) {
  return useCallback(async (): Promise<FormData> => {
    const fd = new FormData();
    if (imageFile) {
      const canvas = previewRef.current;
      if (!canvas) {
        throw new Error('预览画布尚未就绪，请稍后重试。');
      }
      const blob = await exportCanvasBlob(canvas);
      fd.append('image', blob, 'cropped.png');
      fd.append('threshold', String(threshold));
      fd.append('mode', mode);
    }
    if (audioFile) fd.append('audio', audioFile);
    fd.append('frame_name', frameName.trim());
    return fd;
  }, [audioFile, frameName, imageFile, mode, previewRef, threshold]);
}

function exportCanvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas export failed'))),
      'image/png'
    );
  });
}
