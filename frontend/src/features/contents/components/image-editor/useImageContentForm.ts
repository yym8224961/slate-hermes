import { useCallback, useRef, useState } from 'react';
import {
  BW_THRESHOLD_DEFAULT,
  DEFAULT_DITHER_MODE,
  DEFAULT_TTS_VOICE,
  type ContentDetailT,
  type DitherMode,
  type TtsVoiceT,
} from 'shared';
import { exportCanvasBlob } from './canvas-export';
import type { ImageAudioMode } from './ImageAudioBlock';

export function useImageContentForm(content?: ContentDetailT) {
  const isEdit = !!content;
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioMode, setAudioMode] = useState<ImageAudioMode>(
    content?.audio_source === 'tts' ? 'tts' : 'upload'
  );
  const [ttsText, setTtsText] = useState(content?.audio_text ?? '');
  const [ttsVoice, setTtsVoice] = useState<TtsVoiceT>(content?.audio_voice ?? DEFAULT_TTS_VOICE);
  const [threshold, setThreshold] = useState(BW_THRESHOLD_DEFAULT);
  const [mode, setMode] = useState<DitherMode>(DEFAULT_DITHER_MODE);
  const [frameName, setFrameName] = useState(content?.frame_name ?? '');
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const frameNameChanged = isEdit && frameName !== (content.frame_name ?? '');
  const trimmedTtsText = ttsText.trim();
  const existingTtsText = content?.audio_text?.trim() ?? '';
  const hasExistingTts = isEdit && content?.audio_source === 'tts';
  const wantsTts =
    audioMode === 'tts' &&
    trimmedTtsText.length > 0 &&
    (!hasExistingTts ||
      content?.audio_status === 'failed' ||
      trimmedTtsText !== existingTtsText ||
      ttsVoice !== content?.audio_voice);
  const hasImagePatch = !!imageFile || !!audioFile || frameNameChanged;
  const canCreate = !!imageFile && (audioMode !== 'tts' || trimmedTtsText.length > 0);
  const canEdit = (hasImagePatch || wantsTts) && (audioMode !== 'tts' || trimmedTtsText.length > 0);

  const resetCrop = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const onImagePick = useCallback(
    (file: File | null) => {
      setImageFile(file);
      resetCrop();
    },
    [resetCrop]
  );

  const reset = useCallback(() => {
    setImageFile(null);
    setAudioFile(null);
    setAudioMode('upload');
    setTtsText('');
    setTtsVoice(DEFAULT_TTS_VOICE);
    setThreshold(BW_THRESHOLD_DEFAULT);
    setMode(DEFAULT_DITHER_MODE);
    setFrameName('');
    resetCrop();
  }, [resetCrop]);

  const buildFormData = useCallback(async (): Promise<FormData> => {
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
  }, [audioFile, frameName, imageFile, mode, threshold]);

  return {
    previewRef,
    imageFile,
    setImageFile,
    audioFile,
    setAudioFile,
    audioMode,
    setAudioMode,
    ttsText,
    setTtsText,
    ttsVoice,
    setTtsVoice,
    threshold,
    setThreshold,
    mode,
    setMode,
    frameName,
    setFrameName,
    scale,
    setScale,
    offset,
    setOffset,
    trimmedTtsText,
    wantsTts,
    hasImagePatch,
    canCreate,
    canEdit,
    reset,
    resetCrop,
    onImagePick,
    buildFormData,
  };
}
