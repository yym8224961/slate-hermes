import { useCallback, useRef, useState } from 'react';
import {
  BW_THRESHOLD_DEFAULT,
  DEFAULT_DITHER_MODE,
  type ContentDetailT,
  type DitherMode,
} from 'shared';
import { useAudioFormState } from './useAudioFormState';
import { useCropState } from './useCropState';
import { useImageFormSubmit } from './useImageFormSubmit';

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

  const buildFormData = useImageFormSubmit({
    imageFile,
    audioFile: audio.audioFile,
    previewRef,
    frameName,
    threshold,
    mode,
  });

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
