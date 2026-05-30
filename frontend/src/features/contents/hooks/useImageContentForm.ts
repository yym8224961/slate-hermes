import { useCallback, useMemo, useRef, useState } from 'react';
import {
  BW_THRESHOLD_DEFAULT,
  DEFAULT_DITHER_MODE,
  DEFAULT_TTS_VOICE,
  type ContentDetailT,
  type DitherMode,
  type TtsVoiceT,
} from 'shared';
import { exportCanvasBlob } from '@/features/contents/components/image-editor/canvas-export';
import type { ImageAudioMode } from '@/features/contents/components/image-editor/ImageAudioBlock';

export function useImageContentForm(content?: ContentDetailT) {
  const isEdit = !!content;
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const audio = useAudioFormState(content);
  const [threshold, setThreshold] = useState(BW_THRESHOLD_DEFAULT);
  const [mode, setMode] = useState<DitherMode>(DEFAULT_DITHER_MODE);
  const [frameName, setFrameName] = useState(content?.frame_name ?? '');
  const { scale, setScale, offset, setOffset, resetCrop } = useCropState();
  const frameNameChanged = isEdit && frameName !== (content.frame_name ?? '');
  const trimmedTtsText = audio.ttsText.trim();
  const existingTtsText = content?.audio_text?.trim() ?? '';
  const hasExistingTts = isEdit && content?.audio_source === 'tts';
  const wantsTts =
    audio.audioMode === 'tts' &&
    trimmedTtsText.length > 0 &&
    (!hasExistingTts ||
      content?.audio_status === 'failed' ||
      trimmedTtsText !== existingTtsText ||
      audio.ttsVoice !== content?.audio_voice);
  const hasImagePatch = !!imageFile || !!audio.audioFile || frameNameChanged;
  const canCreate = !!imageFile && (audio.audioMode !== 'tts' || trimmedTtsText.length > 0);
  const canEdit =
    (hasImagePatch || wantsTts) && (audio.audioMode !== 'tts' || trimmedTtsText.length > 0);

  const onImagePick = useCallback(
    (file: File | null) => {
      setImageFile(file);
      resetCrop();
    },
    [resetCrop]
  );

  const reset = useCallback(() => {
    setImageFile(null);
    audio.resetAudio();
    setThreshold(BW_THRESHOLD_DEFAULT);
    setMode(DEFAULT_DITHER_MODE);
    setFrameName('');
    resetCrop();
  }, [audio, resetCrop]);

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
    if (audio.audioFile) fd.append('audio', audio.audioFile);
    fd.append('frame_name', frameName.trim());
    return fd;
  }, [audio.audioFile, frameName, imageFile, mode, threshold]);

  return {
    image: {
      previewRef,
      file: imageFile,
      setFile: setImageFile,
      onPick: onImagePick,
    },
    audio: {
      file: audio.audioFile,
      setFile: audio.setAudioFile,
      mode: audio.audioMode,
      setMode: audio.setAudioMode,
      ttsText: audio.ttsText,
      setTtsText: audio.setTtsText,
      ttsVoice: audio.ttsVoice,
      setTtsVoice: audio.setTtsVoice,
      trimmedTtsText,
      wantsTts,
    },
    dither: {
      threshold,
      setThreshold,
      mode,
      setMode,
    },
    crop: {
      scale,
      setScale,
      offset,
      setOffset,
      reset: resetCrop,
    },
    form: {
      frameName,
      setFrameName,
      hasImagePatch,
      canCreate,
      canEdit,
      reset,
      buildFormData,
    },
  };
}

function useCropState() {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const resetCrop = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  return { scale, setScale, offset, setOffset, resetCrop };
}

function useAudioFormState(content?: ContentDetailT) {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioMode, setAudioMode] = useState<ImageAudioMode>(
    content?.audio_source === 'tts' ? 'tts' : 'upload'
  );
  const [ttsText, setTtsText] = useState(content?.audio_text ?? '');
  const [ttsVoice, setTtsVoice] = useState<TtsVoiceT>(content?.audio_voice ?? DEFAULT_TTS_VOICE);

  const resetAudio = useCallback(() => {
    setAudioFile(null);
    setAudioMode('upload');
    setTtsText('');
    setTtsVoice(DEFAULT_TTS_VOICE);
  }, []);

  return useMemo(
    () => ({
      audioFile,
      setAudioFile,
      audioMode,
      setAudioMode,
      ttsText,
      setTtsText,
      ttsVoice,
      setTtsVoice,
      resetAudio,
    }),
    [audioFile, audioMode, resetAudio, ttsText, ttsVoice]
  );
}
