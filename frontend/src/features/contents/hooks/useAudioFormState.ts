import { useCallback, useMemo, useState } from 'react';
import { DEFAULT_TTS_VOICE, type ContentDetailT, type TtsVoiceT } from 'shared';
import type { ImageAudioMode } from '@/features/contents/components/image-editor/ImageAudioBlock';

export function useAudioFormState(content?: ContentDetailT) {
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
